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

const ATOM_SAFE = /^[^\s"\\(){}%*\[\]]+$/

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
