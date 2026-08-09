const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export function base64ToBytes(b64: string): Uint8Array {
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "")
    const out: number[] = []
    let buffer = 0
    let bits = 0
    for (const ch of clean) {
        if (ch === "=") break
        const v = B64_ALPHABET.indexOf(ch)
        if (v === -1) continue
        buffer = (buffer << 6) | v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out.push((buffer >> bits) & 0xff)
        }
    }
    return Uint8Array.from(out)
}

export function bytesToBase64(bytes: Uint8Array): string {
    let out = ""
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]!
        const b1 = bytes[i + 1]
        const b2 = bytes[i + 2]
        out += B64_ALPHABET[b0 >> 2]
        out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
        out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
        out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 63]
    }
    return out
}

/** Decodes quoted-printable encoded text (RFC 2045 §6.7) into bytes. */
export function decodeQuotedPrintable(input: string): Uint8Array {
    const s = input.replace(/=\r?\n/g, "")
    const out: number[] = []
    let i = 0
    while (i < s.length) {
        const c = s[i]!
        if (c === "=" && i + 2 < s.length && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
            out.push(parseInt(s.slice(i + 1, i + 3), 16))
            i += 3
        } else {
            out.push(c.charCodeAt(0))
            i++
        }
    }
    return Uint8Array.from(out)
}

// windows-1252 bytes 0x80-0x9F mapped to Unicode
const WIN1252_HIGH = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178
]

/** Decodes bytes according to a charset. Falls back to latin-1 for unknown charsets. */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
    const cs = (charset ?? "utf-8").toLowerCase().replace(/[_\s]/g, "-")

    if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii" || cs === "ansi-x3.4-1968") {
        return new TextDecoder("utf-8").decode(bytes)
    }

    if (cs === "iso-8859-1" || cs === "iso8859-1" || cs === "latin1" || cs === "latin-1"
        || cs.startsWith("iso-8859-") || cs.startsWith("iso8859-") || cs === "koi8-r" || cs === "koi8-u") {
        let out = ""
        for (const b of bytes) out += String.fromCharCode(b)
        return out
    }

    if (cs === "windows-1252" || cs === "cp1252" || cs === "win-1252") {
        let out = ""
        for (const b of bytes) {
            if (b >= 0x80 && b <= 0x9F) out += String.fromCharCode(WIN1252_HIGH[b - 0x80]!)
            else out += String.fromCharCode(b)
        }
        return out
    }

    try {
        return new TextDecoder(cs).decode(bytes)
    } catch {
        let out = ""
        for (const b of bytes) out += String.fromCharCode(b)
        return out
    }
}

const MIME_WORD_REGEX = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g

function decodeEncodedWord(charset: string, enc: string, text: string): string {
    if (enc.toUpperCase() === "B") {
        return decodeBytes(base64ToBytes(text), charset)
    }
    // Q-encoding: underscore → space, =HH → raw byte
    const withSpaces = text.replace(/_/g, " ")
    return decodeBytes(decodeQuotedPrintable(withSpaces), charset)
}

/**
 * Decodes RFC 2047 encoded words (=?charset?B?..?= / =?charset?Q?..?=) in a
 * string, dropping whitespace between adjacent encoded words.
 */
export function decodeMimeEncodedWords(input: string): string {
    const matches = [...input.matchAll(MIME_WORD_REGEX)]
    if (matches.length === 0) return input

    let out = ""
    let lastEnd = 0

    matches.forEach((m, i) => {
        const start = m.index!
        const prev = matches[i - 1]
        let effectiveStart = start
        if (prev) {
            const gap = input.slice(prev.index! + prev[0].length, start)
            if (/^\s+$/.test(gap)) effectiveStart = prev.index! + prev[0].length
        }
        out += input.slice(lastEnd, effectiveStart)
        out += decodeEncodedWord(m[1]!, m[2]!, m[3]!)
        lastEnd = start + m[0].length
    })

    out += input.slice(lastEnd)
    return out
}
