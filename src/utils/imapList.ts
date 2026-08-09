export type ImapValue = string | ImapValue[]

/**
 * Parses a parenthesized IMAP list (quoted strings, atoms, nested parens)
 * into nested arrays.
 *
 * Example: `(("" "/") ("Archive" "/"))` → [["", "/"], ["Archive", "/"]]
 */
export function parseImapList(text: string): ImapValue[] {
    let i = 0

    const parse = (): ImapValue[] => {
        const out: ImapValue[] = []
        while (i < text.length) {
            const c = text[i]!
            if (c === "(") {
                i++
                out.push(parse())
            } else if (c === ")") {
                i++
                return out
            } else if (c === '"') {
                i++
                let s = ""
                while (i < text.length && text[i] !== '"') {
                    if (text[i] === "\\" && i + 1 < text.length) {
                        i++
                        s += text[i]!
                    } else {
                        s += text[i]!
                    }
                    i++
                }
                i++ // closing quote
                out.push(s)
            } else if (c === " " || c === "\t") {
                i++
            } else {
                let s = ""
                while (i < text.length && !" ()".includes(text[i]!)) {
                    s += text[i]!
                    i++
                }
                out.push(s)
            }
        }
        return out
    }

    return parse()
}

/**
 * Quotes a string as an IMAP quoted string, escaping backslashes and quotes.
 */
export function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// IMAP atoms must be ASCII (RFC 9051 §9: ATOM-CHAR is a 7-bit CHAR); anything
// non-ASCII must be quoted instead of being sent as a raw atom.
const ATOM_SAFE = /^[^\s"\\(){}%*\[\]\x7f-\uffff]+$/

/**
 * Returns the value as-is if it is a safe IMAP atom, otherwise quoted.
 */
export function quoteIfNeeded(value: string): string {
    if (value === "") return '""'
    if (ATOM_SAFE.test(value)) return value
    return quote(value)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Formats a Date as an IMAP search date: dd-Mmm-yyyy */
export function formatImapDate(value: Date): string {
    return `${value.getDate()}-${MONTHS[value.getMonth()]}-${value.getFullYear()}`
}

/** Formats a Date as an IMAP internal date: dd-Mmm-yyyy HH:mm:ss +ZZZZ */
export function formatInternalDate(value: Date): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, "0")
    const tzOffset = -value.getTimezoneOffset()
    const tz = `${tzOffset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(tzOffset) / 60))}${pad(Math.abs(tzOffset) % 60)}`
    return `${pad(value.getDate())}-${MONTHS[value.getMonth()]}-${value.getFullYear()} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())} ${tz}`
}

/**
 * Parses an IMAP date-time string (RFC 9051 §9: dd-MMM-yyyy HH:mm:ss +ZZZZ,
 * e.g. "17-Jul-1996 02:44:25 -0700") into a Date deterministically.
 * Returns an invalid Date when the input cannot be parsed.
 */
export function parseInternalDate(value: string): Date {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value.trim())
    if (!m) return new Date(NaN)
    const month = MONTHS.findIndex(mon => mon.toLowerCase() === m[2]!.toLowerCase())
    if (month === -1) return new Date(NaN)
    const sign = m[7] === "-" ? -1 : 1
    const offsetMin = sign * (parseInt(m[8]!, 10) * 60 + parseInt(m[9]!, 10))
    const utc = Date.UTC(
        parseInt(m[3]!, 10),
        month,
        parseInt(m[1]!, 10),
        parseInt(m[4]!, 10),
        parseInt(m[5]!, 10),
        parseInt(m[6]!, 10)
    ) - offsetMin * 60000
    return new Date(utc)
}

// Modified base64 alphabet for modified UTF-7 (RFC 2152 §4): "+" → "&", "/" → ","
const MUTF7_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,"

/**
 * Encodes a string as modified UTF-7 (RFC 2152), the mailbox name encoding
 * used by IMAP4rev1. Printable ASCII (except "&") is passed through; other
 * characters are base64-encoded UTF-16BE between "&" and "-".
 */
export function encodeMutf7(input: string): string {
    let out = ""
    let buf: number[] = []

    const flush = () => {
        if (buf.length === 0) return
        const bytes = new Uint8Array(buf)
        let b64 = ""
        for (let i = 0; i < bytes.length; i += 3) {
            const b0 = bytes[i]!
            const b1 = bytes[i + 1]
            const b2 = bytes[i + 2]
            b64 += MUTF7_ALPHABET[b0 >> 2]
            b64 += MUTF7_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
            if (b1 !== undefined) {
                b64 += MUTF7_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
                if (b2 !== undefined) b64 += MUTF7_ALPHABET[b2 & 63]
            }
        }
        out += "&" + b64.replace(/=+$/, "") + "-"
        buf = []
    }

    for (const ch of input) {
        const cp = ch.codePointAt(0)!
        if (cp >= 0x20 && cp <= 0x7e && ch !== "&") {
            flush()
            out += ch
        } else if (ch === "&") {
            flush()
            out += "&-"
        } else if (cp > 0xffff) {
            // astral code point → UTF-16 surrogate pair
            const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800
            const lo = ((cp - 0x10000) % 0x400) + 0xdc00
            buf.push((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
        } else {
            buf.push((cp >> 8) & 0xff, cp & 0xff)
        }
    }
    flush()
    return out
}

/** Decodes a modified UTF-7 (RFC 2152) string back into Unicode. */
export function decodeMutf7(input: string): string {
    let out = ""
    let i = 0

    while (i < input.length) {
        const amp = input.indexOf("&", i)
        if (amp === -1) {
            out += input.slice(i)
            break
        }
        out += input.slice(i, amp)
        const end = input.indexOf("-", amp + 1)
        if (end === -1) {
            out += input.slice(amp)
            break
        }
        const chunk = input.slice(amp + 1, end)
        if (chunk === "") {
            out += "&"
        } else {
            const bytes: number[] = []
            let buffer = 0
            let bits = 0
            for (const ch of chunk) {
                if (ch === "=") break
                const v = MUTF7_ALPHABET.indexOf(ch)
                if (v === -1) continue
                buffer = (buffer << 6) | v
                bits += 6
                if (bits >= 8) {
                    bits -= 8
                    bytes.push((buffer >> bits) & 0xff)
                }
            }
            for (let j = 0; j + 1 < bytes.length; j += 2) {
                out += String.fromCharCode((bytes[j]! << 8) | bytes[j + 1]!)
            }
        }
        i = end + 1
    }

    return out
}

/**
 * Splits the content of a [...] response code section into top-level
 * tokens, keeping parenthesized groups (e.g. PERMANENTFLAGS (\Seen \Deleted))
 * together.
 */
export function splitResponseCodes(bracketContent: string): string[] {
    const out: string[] = []
    let cur = ""
    let depth = 0
    for (const ch of bracketContent) {
        if (ch === "(") depth++
        else if (ch === ")") depth--
        if (ch === " " && depth === 0) {
            if (cur) out.push(cur)
            cur = ""
            continue
        }
        cur += ch
    }
    if (cur) out.push(cur)
    return out
}
