import type { SearchEmailsProps } from "../types/emails"
import { formatImapDate, quote, quoteIfNeeded } from "./imapList"

const FLAG_KEYS: Record<string, string> = {
    answered: "ANSWERED",
    deleted: "DELETED",
    draft: "DRAFT",
    flagged: "FLAGGED",
    seen: "SEEN",
    new: "NEW",
    old: "OLD",
    recent: "RECENT"
}

const FLAG_KEYS_WITH_UN: string[] = ["answered", "deleted", "draft", "flagged", "seen"]

const STRING_KEYS: string[] = ["bcc", "body", "cc", "from", "subject", "text", "to"]

const DATE_KEYS: string[] = ["before", "on", "since", "sentBefore", "sentOn", "sentSince"]

function buildOr(pairs: Array<[string, string]>): string {
    const keys = pairs.map(([k, v]) => `(${k.toUpperCase()} ${quoteIfNeeded(v)})`)
    const chain = (arr: string[]): string => {
        if (arr.length === 1) return arr[0]!
        const [first, ...rest] = arr
        const inner = chain(rest)
        return `OR ${first} ${rest.length === 1 ? inner : `(${inner})`}`
    }
    return chain(keys)
}

/**
 * Builds the SEARCH criteria string from the props object.
 * Returns null when there is nothing to search for.
 */
export function buildSearchQuery(props: SearchEmailsProps): string | null {
    if (props.all) return "ALL"

    const opts: string[] = []

    for (const [key, value] of Object.entries(props)) {
        if (key === "all" || key === "useUid") continue

        if (key in FLAG_KEYS) {
            if (value) opts.push(FLAG_KEYS[key]!)
            else if (FLAG_KEYS_WITH_UN.includes(key)) opts.push(`UN${FLAG_KEYS[key]}`)
            continue
        }

        if (STRING_KEYS.includes(key)) {
            if (value !== undefined) opts.push(`${key.toUpperCase()} ${quoteIfNeeded(String(value))}`)
            continue
        }

        if (key === "keyword" || key === "unkeyword") {
            if (value !== undefined) opts.push(`${key.toUpperCase()} ${quoteIfNeeded(String(value))}`)
            continue
        }

        if (key === "header" && value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
            const h = value as { key: string, value: string }
            opts.push(`HEADER ${quote(h.key)} ${quote(h.value)}`)
            continue
        }

        if (key === "largerThan" || key === "smallerThan") {
            if (typeof value === "number") opts.push(`${key.replace("Than", "").toUpperCase()} ${value}`)
            continue
        }

        if (DATE_KEYS.includes(key) && value instanceof Date && !isNaN(value.valueOf())) {
            opts.push(`${key.toUpperCase()} ${formatImapDate(value)}`)
            continue
        }

        if (key === "uid" && value !== undefined) {
            opts.push(`UID ${String(value)}`)
            continue
        }

        if (key === "not" && value !== undefined) {
            opts.push(`NOT TEXT ${quoteIfNeeded(String(value))}`)
            continue
        }

        if (key === "or" && Array.isArray(value) && value.length > 0) {
            opts.push(buildOr(value))
            continue
        }
    }

    return opts.length > 0 ? opts.join(" ") : null
}
