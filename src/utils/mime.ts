import { base64ToBytes, bytesToBase64, decodeBytes, decodeMimeEncodedWords, decodeQuotedPrintable } from "./decodeMime"
import type { Attachment } from "../types/emails"

/** Splits raw header section into an unfolded, MIME-word-decoded map (lowercased names). */
export function parseHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {}
    let current: string | null = null

    for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(" ") || line.startsWith("\t")) {
            if (current) headers[current] += " " + line.trim()
            continue
        }
        const idx = line.indexOf(":")
        if (idx === -1) continue
        current = line.slice(0, idx).trim().toLowerCase()
        headers[current] = line.slice(idx + 1).trim()
    }

    for (const key of Object.keys(headers)) {
        headers[key] = decodeMimeEncodedWords(headers[key]!)
    }

    return headers
}

/** Splits an address header value (e.g. "Name <a@b.c>, d@e.f") into individual addresses. */
export function parseAddresses(value: string): string[] {
    if (!value) return []
    const out: string[] = []
    let depth = 0
    let inQuote = false
    let start = 0

    for (let i = 0; i < value.length; i++) {
        const c = value[i]!
        if (c === '"') inQuote = !inQuote
        if (!inQuote) {
            if (c === "<") depth++
            else if (c === ">") depth--
            else if (c === "," && depth === 0) {
                const addr = value.slice(start, i).trim()
                if (addr) out.push(addr)
                start = i + 1
            }
        }
    }

    const last = value.slice(start).trim()
    if (last) out.push(last)

    return out
}

export function parseContentType(value: string): { mimeType: string, params: Record<string, string> } {
    const parts = value.split(";")
    const mimeType = parts[0]!.trim().toLowerCase()
    const params: Record<string, string> = {}
    for (const p of parts.slice(1)) {
        const idx = p.indexOf("=")
        if (idx === -1) continue
        const key = p.slice(0, idx).trim().toLowerCase()
        let val = p.slice(idx + 1).trim()
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1)
        params[key] = val
    }
    return { mimeType, params }
}

export type ParsedPart = {
    contentType: string,
    charset?: string,
    encoding: string,
    boundary?: string,
    disposition: "inline" | "attachment" | "none",
    filename?: string,
    contentId?: string,
    headers: Record<string, string>,
    body: Uint8Array,
    children: ParsedPart[]
}

const CRLFCRLF = new Uint8Array([13, 10, 13, 10])
const MAX_DEPTH = 10

function indexOfSub(hay: Uint8Array, needle: Uint8Array, from = 0): number {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) continue outer
        }
        return i
    }
    return -1
}

function stripTrailingCRLF(bytes: Uint8Array): Uint8Array {
    if (bytes.length >= 2 && bytes[bytes.length - 2] === 13 && bytes[bytes.length - 1] === 10) {
        return bytes.slice(0, bytes.length - 2)
    }
    return bytes
}

function splitMimeParts(bytes: Uint8Array, boundary: string): Uint8Array[] {
    const delimBytes = new TextEncoder().encode(`\r\n--${boundary}`)
    const bareBytes = new TextEncoder().encode(`--${boundary}`)
    const parts: Uint8Array[] = []

    let pos: number
    if (indexOfSub(bytes, bareBytes, 0) === 0) {
        pos = bareBytes.length
    } else {
        const first = indexOfSub(bytes, delimBytes, 0)
        if (first === -1) return [bytes]
        pos = first + delimBytes.length
    }

    for (;;) {
        const next = indexOfSub(bytes, delimBytes, pos)
        if (next === -1) {
            parts.push(stripTrailingCRLF(bytes.slice(pos)))
            break
        }
        parts.push(stripTrailingCRLF(bytes.slice(pos, next)))
        pos = next + delimBytes.length
        // closing delimiter "--"
        if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break
    }

    return parts
}

/** Parses a raw MIME message/part (bytes) into a structural tree. */
export function parseMime(raw: Uint8Array, depth = 0): ParsedPart {
    const sep = indexOfSub(raw, CRLFCRLF)
    const sepAlt = sep === -1 ? indexOfSub(raw, new TextEncoder().encode("\n\n")) : sep
    const headerBytes = sepAlt === -1 ? raw : raw.slice(0, sepAlt)
    const body = sepAlt === -1 ? new Uint8Array(0) : raw.slice(sepAlt + (sep !== -1 ? 4 : 2))

    const headers = parseHeaders(new TextDecoder("utf-8").decode(headerBytes))
    const ct = parseContentType(headers["content-type"] ?? "text/plain")
    const encoding = (headers["content-transfer-encoding"] ?? "7bit").trim().toLowerCase()

    let disposition: ParsedPart["disposition"] = "none"
    let filename: string | undefined
    if (headers["content-disposition"]) {
        const d = parseContentType(headers["content-disposition"])
        if (d.mimeType === "attachment") disposition = "attachment"
        else if (d.mimeType === "inline") disposition = "inline"
        filename = d.params.filename ?? d.params["filename*"] ?? filename
    }
    if (!filename) filename = ct.params.name ?? ct.params["name*"]

    const part: ParsedPart = {
        contentType: ct.mimeType,
        charset: ct.params.charset,
        encoding,
        boundary: ct.params.boundary,
        disposition,
        filename,
        contentId: headers["content-id"]?.replace(/^<|>$/g, ""),
        headers,
        body,
        children: []
    }

    if (ct.mimeType.startsWith("multipart/") && ct.params.boundary && depth < MAX_DEPTH) {
        for (const sub of splitMimeParts(body, ct.params.boundary)) {
            part.children.push(parseMime(sub, depth + 1))
        }
    }

    return part
}

function decodePartContent(part: ParsedPart): { bytes: Uint8Array, content: string } {
    switch (part.encoding) {
        case "base64":
            return { bytes: base64ToBytes(new TextDecoder("utf-8").decode(part.body)), content: "" }
        case "quoted-printable": {
            const bytes = decodeQuotedPrintable(new TextDecoder("utf-8").decode(part.body))
            return { bytes, content: "" }
        }
        default: {
            const bytes = part.body
            return { bytes, content: "" }
        }
    }
}

function decodeText(bytes: Uint8Array, part: ParsedPart): string {
    return decodeBytes(bytes, part.charset)
}

export type ExtractedContent = {
    text?: string,
    html?: string,
    attachments: Attachment[]
}

/** Walks a parsed MIME tree, collecting body text and attachments. */
export function extractContent(root: ParsedPart): ExtractedContent {
    const textParts: string[] = []
    const htmlParts: string[] = []
    const attachments: Attachment[] = []

    const walk = (part: ParsedPart) => {
        if (part.children.length > 0) {
            for (const child of part.children) walk(child)
            return
        }

        const isText = part.contentType === "text/plain" || part.contentType === "text/html"
        const { bytes } = decodePartContent(part)
        const content = isText ? decodeText(bytes, part) : bytesToBase64(bytes)

        if (part.disposition === "attachment" || (!isText && part.contentType !== "text/plain" && part.contentType !== "text/html")) {
            attachments.push({
                filename: part.filename ?? "untitled",
                mimeType: part.contentType,
                size: bytes.length,
                encoding: part.encoding,
                content,
                contentBase64: bytesToBase64(bytes),
                contentId: part.contentId,
                isInline: part.disposition === "inline"
            })
            return
        }

        if (isText) {
            if (part.contentType === "text/plain") textParts.push(content)
            else htmlParts.push(content)
        } else if (part.contentId || part.filename) {
            attachments.push({
                filename: part.filename ?? "untitled",
                mimeType: part.contentType,
                size: bytes.length,
                encoding: part.encoding,
                content,
                contentBase64: bytesToBase64(bytes),
                contentId: part.contentId,
                isInline: part.disposition === "inline" || !!part.contentId
            })
        }
    }

    walk(root)

    const result: ExtractedContent = { attachments }
    if (textParts.length) result.text = textParts.join("\n")
    if (htmlParts.length) result.html = htmlParts.join("\n")
    return result
}
