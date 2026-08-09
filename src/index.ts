import { connect } from "cloudflare:sockets"
import type { Email, Attachment, FetchEmailsProps, SearchEmailsProps, MailboxInfo, Folder, Namespace, Options } from "./types/emails"
import { ImapStream, ImapError } from "./utils/imapStream"
import { parseImapList, quote, formatInternalDate, splitResponseCodes } from "./utils/imapList"
import { decodeMimeEncodedWords } from "./utils/decodeMime"
import { parseHeaders, parseAddresses, parseMime, extractContent } from "./utils/mime"
import { buildSearchQuery } from "./utils/search"

export { ImapError }
export type { Options, Email, Attachment, FetchEmailsProps, SearchEmailsProps, MailboxInfo, Folder, Namespace }

export class CFImap {
    private options: Options
    private socket: ReturnType<typeof connect> | null = null
    private stream: ImapStream | null = null
    private writer: WritableStreamDefaultWriter<any> | null = null
    private tagCounter = 0

    session: { id?: string, protocol?: string } = {}
    /** Capabilities advertised by the server, e.g. ["IMAP4rev1", "UIDPLUS"] */
    capabilities: string[] = []

    /**
     * Only used to determine if a folder is selected
     */
    selectedFolder = ""

    constructor(options: Options) {
        this.options = options
    }

    private requireConnection() {
        if (!this.socket || !this.stream || !this.writer) {
            throw new Error("Not connected to an IMAP server. Run the connect() function first.")
        }
    }

    private requireFolder() {
        if (!this.selectedFolder) {
            throw new Error("Folder not selected! Before running this function, run the selectFolder() function.")
        }
    }

    private nextTag(): string {
        return `A${++this.tagCounter}`
    }

    private async send(tag: string, command: string) {
        await this.writer!.write(new TextEncoder().encode(`${tag} ${command}\r\n`))
    }

    /**
     * Connects to the IMAP server and authenticates. Must be run after
     * initialising the CFImap class, otherwise nothing will work.
     */
    connect = async (): Promise<void> => {
        const socketOptions: SocketOptions = { allowHalfOpen: true }
        if (this.options.tls) socketOptions.secureTransport = "starttls"

        let socket = await connect({ hostname: this.options.host, port: this.options.port }, socketOptions)

        if (this.options.tls) {
            socket = socket.startTls()
        }

        this.socket = socket
        this.writer = socket.writable.getWriter()
        this.stream = new ImapStream(socket.readable.getReader(), this.options.timeoutMs)

        const greeting = await this.stream!.readItem()
        const greetingLine = greeting.line

        if (!greetingLine.startsWith("*")) {
            throw new Error(`Unexpected IMAP greeting: ${greetingLine}`, { cause: greeting })
        }

        const greetingCaps = /\[CAPABILITY ([^\]]*)\]/.exec(greetingLine)
        if (greetingCaps) {
            this.capabilities = greetingCaps[1]!.trim().split(/\s+/).filter(Boolean)
        }

        // * PREAUTH means the session is already authenticated (e.g. TLS client certs)
        if (!greetingLine.startsWith("* PREAUTH")) {
            const tag = this.nextTag()
            await this.send(tag, `LOGIN ${quote(this.options.auth.username)} ${quote(this.options.auth.password)}`)
            const { tagged } = await this.stream!.readUntilTag(tag)

            const loginCaps = /\[CAPABILITY ([^\]]*)\]/.exec(tagged.line)
            if (loginCaps) {
                this.capabilities = loginCaps[1]!.trim().split(/\s+/).filter(Boolean)
            }
        }

        const protocol = this.capabilities.find(c => c.toLowerCase().startsWith("imap4"))
        this.session = {
            id: /SESSIONID=<([^>]+)>/.exec(greetingLine)?.[1],
            protocol
        }
    }

    /**
     * Returns the prefixes and hierarchy delimiters of the personal, other
     * and shared namespaces available to the logged in user.
     */
    getNamespaces = async (): Promise<{ personal: Namespace[], other: Namespace[], shared: Namespace[] }> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, "NAMESPACE")
        const { items } = await this.stream!.readUntilTag(tag)

        for (const item of items) {
            if (!item.line.startsWith("* NAMESPACE")) continue

            const list = parseImapList(item.line.slice("* NAMESPACE".length).trim())
            const mapGroup = (v: unknown): Namespace[] => {
                if (v === "NIL" || !Array.isArray(v)) return []
                return v.map(pair => {
                    const arr = pair as unknown[]
                    return {
                        prefix: String(arr[0] ?? ""),
                        delimiter: String(arr[1] ?? "")
                    }
                })
            }

            return {
                personal: mapGroup(list[0]),
                other: mapGroup(list[1]),
                shared: mapGroup(list[2])
            }
        }

        throw new Error("No NAMESPACE response received", { cause: items })
    }

    /**
     * Returns all folders in the specified namespace along with their flags.
     * @param {string} namespace - From which namespace to list folders (usually "" or the prefix from getNamespaces())
     * @param {string} filter - Pattern filter, e.g. "*" or "INBOX*"
     */
    getFolders = async (namespace: string, filter = "*"): Promise<Folder[]> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, `LIST ${quote(namespace)} ${quote(filter)}`)
        const { items } = await this.stream!.readUntilTag(tag)

        const folders: Folder[] = []

        for (const item of items) {
            if (!item.line.startsWith("* LIST")) continue

            const list = parseImapList(item.line.slice("* LIST".length).trim())
            if (list.length < 3) continue

            const attrs = list[0]
            const attributes = Array.isArray(attrs)
                ? attrs.map(a => String(a).replace(/^\\/, ""))
                : []

            let name = String(list[2] ?? "")
            if (/\{\d+\+?\}$/.test(item.line) && item.literal) {
                name = new TextDecoder("utf-8").decode(item.literal)
            }

            folders.push({
                name,
                delimiter: list[1] === "NIL" ? "" : String(list[1]),
                attributes
            })
        }

        return folders
    }

    /**
     * Selects a folder for use in the email GET & FETCH functions. Must be
     * run before those commands (or pass the folder prop to fetchEmails()).
     * @param folder - Selectable folder
     */
    selectFolder = async (folder: string): Promise<MailboxInfo> => {
        this.requireConnection()

        if (!folder) throw new Error("Folder not given")

        const tag = this.nextTag()
        await this.send(tag, `SELECT ${quote(folder)}`)
        const { items, tagged } = await this.stream!.readUntilTag(tag)

        const info: MailboxInfo = {
            emails: 0,
            recent: 0,
            flags: [],
            permanentFlags: [],
            readOnly: false
        }

        const applyCodes = (line: string) => {
            const codes = /\[([^\]]*)\]/.exec(line)
            if (!codes) return
            const tokens = splitResponseCodes(codes[1])
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i]!.toUpperCase()
                if (t === "UIDVALIDITY") info.uidValidity = parseInt(tokens[i + 1]!)
                else if (t === "UIDNEXT") info.uidNext = parseInt(tokens[i + 1]!)
                else if (t === "UNSEEN") info.unseen = parseInt(tokens[i + 1]!)
                else if (t === "READ-ONLY") info.readOnly = true
                else if (t === "READ-WRITE") info.readOnly = false
                else if (t === "PERMANENTFLAGS") {
                    const next = tokens[i + 1]
                    if (next?.startsWith("(")) {
                        info.permanentFlags = next.slice(1, -1).split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
                    }
                }
            }
        }

        for (const item of items) {
            const line = item.line

            const exists = /^\* (\d+) EXISTS$/.exec(line)
            if (exists) {
                info.emails = parseInt(exists[1])
                continue
            }

            const recent = /^\* (\d+) RECENT$/.exec(line)
            if (recent) {
                info.recent = parseInt(recent[1])
                continue
            }

            if (line.startsWith("* FLAGS")) {
                const list = parseImapList(line.slice("* FLAGS".length).trim())
                if (Array.isArray(list[0])) {
                    info.flags = list[0].map(f => String(f).replace(/^\\/, ""))
                }
                continue
            }

            // Dovecot and others send UIDVALIDITY/UIDNEXT/PERMANENTFLAGS etc.
            // as untagged "* OK [...]" lines
            if (line.startsWith("* OK [")) applyCodes(line)
        }

        applyCodes(tagged.line)

        this.selectedFolder = folder
        return info
    }

    /**
     * Fetches emails from a folder specified by the selectFolder() function
     * (or via the folder prop).
     *
     * @param {Object} props - Props
     * @param {number} [props.byteLimit] - Maximum size of the emails to fetch (optional, not recommended)
     * @param {[ number, number ] | number} props.limit - Range of sequence numbers to fetch (or a single one)
     * @param {boolean} [props.peek=true] - If true (default), fetching won't set the \Seen flag
     * @param {boolean} [props.fetchBody=true] - If true (default), the full message is fetched and parsed
     */
    fetchEmails = async ({ folder, limit, fetchBody = true, byteLimit, peek = true, useUid = false }: FetchEmailsProps): Promise<Email[]> => {
        this.requireConnection()

        if (folder && folder !== this.selectedFolder) {
            await this.selectFolder(folder)
        } else if (!folder) {
            this.requireFolder()
        }

        const range = Array.isArray(limit) ? limit.join(":") : String(limit)
        const bodyCommand = fetchBody
            ? `BODY${peek ? ".PEEK" : ""}[]${byteLimit ? ` <${byteLimit}>` : ""}`
            : `BODY${peek ? ".PEEK" : ""}[HEADER.FIELDS (SUBJECT FROM TO CC MESSAGE-ID CONTENT-TYPE DATE)]`

        const tag = this.nextTag()
        await this.send(tag, `${useUid ? "UID " : ""}FETCH ${range} (UID FLAGS INTERNALDATE RFC822.SIZE ${bodyCommand})`)
        const { items } = await this.stream!.readUntilTag(tag)

        const emails: Email[] = []
        const LIT = "\u0000"
        const tokens: string[] = []

        for (const item of items) {
            const m = /\{(\d+)\+?\}$/.exec(item.line)
            if (m && item.literal) {
                tokens.push(item.line.slice(0, -m[0].length))
                tokens.push(LIT + new TextDecoder("utf-8").decode(item.literal))
            } else {
                tokens.push(item.line)
            }
        }

        let i = 0
        while (i < tokens.length) {
            const opening = /^\* (\d+) FETCH \(([\s\S]*)$/.exec(tokens[i]!)
            if (!opening) {
                i++
                continue
            }

            const seq = parseInt(opening[1])
            i++

            // Collect the fetch data until the standalone closing paren
            let data = opening[2] ?? ""
            const parts: { section: "header" | "body" | null, content: string }[] = []
            let pendingSection: "header" | "body" | null = null
            if (/BODY\[HEADER/i.test(data)) pendingSection = "header"
            else if (/BODY\[/i.test(data)) pendingSection = "body"

            for (; i < tokens.length; i++) {
                const token = tokens[i]!
                if (token.startsWith(LIT)) {
                    if (pendingSection) parts.push({ section: pendingSection, content: token.slice(LIT.length) })
                    pendingSection = null
                    continue
                }
                if (token.trim() === ")") {
                    i++
                    break
                }
                data += " " + token
                if (/BODY\[HEADER/i.test(token)) pendingSection = "header"
                else if (/BODY\[/i.test(token)) pendingSection = "body"
            }

            const uidMatch = /UID (\d+)/.exec(data)
            const flagsMatch = /FLAGS \(([^)]*)\)/.exec(data)
            const dateMatch = /INTERNALDATE "([^"]+)"/.exec(data)
            const sizeMatch = /RFC822\.SIZE (\d+)/.exec(data)

            const headerPart = parts.find(p => p.section === "header")
            const bodyPart = parts.find(p => p.section === "body")

            let rawMessage: string
            if (fetchBody && bodyPart) {
                rawMessage = bodyPart.content
            } else {
                rawMessage = ""
            }

            let headerStr: string
            if (fetchBody && rawMessage) {
                const sepIdx = rawMessage.indexOf("\r\n\r\n")
                headerStr = sepIdx === -1 ? rawMessage : rawMessage.slice(0, sepIdx)
            } else {
                headerStr = headerPart?.content ?? ""
            }

            const headerMap = parseHeaders(headerStr)

            const email: Email = {
                uid: uidMatch ? parseInt(uidMatch[1]) : NaN,
                seq,
                flags: flagsMatch
                    ? flagsMatch[1].split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
                    : [],
                internalDate: dateMatch ? new Date(dateMatch[1]) : new Date(NaN),
                size: sizeMatch ? parseInt(sizeMatch[1]) : NaN,
                from: parseAddresses(headerMap["from"] ?? ""),
                to: parseAddresses(headerMap["to"] ?? ""),
                cc: parseAddresses(headerMap["cc"] ?? ""),
                subject: headerMap["subject"] ?? "",
                messageID: headerMap["message-id"] ?? "",
                contentType: headerMap["content-type"] ?? "",
                headers: headerMap,
                rawHeaders: headerStr,
                body: {
                    text: undefined,
                    html: undefined,
                    raw: rawMessage
                },
                attachments: [],
                raw: rawMessage || headerStr
            }

            if (fetchBody && rawMessage) {
                const root = parseMime(new TextEncoder().encode(rawMessage))
                const extracted = extractContent(root)
                email.body.text = extracted.text
                email.body.html = extracted.html
                email.attachments = extracted.attachments
            }

            emails.push(email)
        }

        return emails
    }

    /**
     * Searches emails based on the props given. Returns sequence numbers
     * (or UIDs with useUid: true).
     */
    searchEmails = async (props: SearchEmailsProps): Promise<number[]> => {
        this.requireConnection()
        this.requireFolder()

        if (!props) throw new Error("Props not given")

        const query = buildSearchQuery(props)
        if (!query) throw new Error("No search options given. You must specify at least one search option.")

        const tag = this.nextTag()
        await this.send(tag, `${props.useUid ? "UID " : ""}SEARCH ${query}`)
        const { items } = await this.stream!.readUntilTag(tag)

        const ids: number[] = []

        for (const item of items) {
            if (!item.line.startsWith("* SEARCH")) continue
            const parts = item.line.slice("* SEARCH".length).trim().split(/\s+/)
            for (const part of parts) {
                if (part === "") continue
                const n = parseInt(part)
                if (!isNaN(n)) ids.push(n)
            }
        }

        return ids
    }

    /**
     * Adds, removes or replaces flags on one or more messages.
     * @param target - Sequence number range (or UID range with useUid), e.g. "1:5" or "42"
     * @param flags - Flags without the backslash, e.g. ["Seen", "Flagged"]
     * @param mode - add (default), remove or replace
     */
    storeFlags = async (target: string, flags: string[], mode: "add" | "remove" | "replace" = "add", useUid = false): Promise<Array<{ seq: number, flags: string[] }>> => {
        this.requireConnection()
        this.requireFolder()

        if (!flags.length) throw new Error("No flags given")

        const op = mode === "add" ? "+FLAGS" : mode === "remove" ? "-FLAGS" : "FLAGS"
        const flagStr = flags.map(f => f.startsWith("\\") ? f : `\\${f}`).join(" ")

        const tag = this.nextTag()
        await this.send(tag, `${useUid ? "UID " : ""}STORE ${target} ${op} (${flagStr})`)
        const { items } = await this.stream!.readUntilTag(tag)

        const result: Array<{ seq: number, flags: string[] }> = []
        for (const item of items) {
            const m = /^\* (\d+) FETCH \((?:UID \d+ )?FLAGS \(([^)]*)\)(?: UID \d+)?\)$/.exec(item.line)
            if (!m) continue
            result.push({
                seq: parseInt(m[1]),
                flags: m[2].split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
            })
        }
        return result
    }

    /**
     * Permanently removes messages marked with the \Deleted flag.
     * @param opts.range - Optional sequence/UID range to restrict expunging to.
     * @param opts.useUid - Use UID EXPUNGE (requires a range; only removes the expunged UIDs of the selected mailbox)
     */
    expunge = async (opts: { range?: string, useUid?: boolean } = {}): Promise<number[]> => {
        this.requireConnection()
        this.requireFolder()

        if (opts.useUid && !opts.range) {
            throw new Error("UID EXPUNGE requires a range, e.g. { range: '1:10', useUid: true }")
        }

        const tag = this.nextTag()
        await this.send(tag, `${opts.useUid ? "UID " : ""}EXPUNGE${opts.range ? ` ${opts.range}` : ""}`)
        const { items } = await this.stream!.readUntilTag(tag)

        const expunged: number[] = []
        for (const item of items) {
            const m = /^\* (\d+) EXPUNGE/.exec(item.line)
            if (m) expunged.push(parseInt(m[1]))
        }
        return expunged
    }

    /**
     * Copies messages to another folder.
     * @param target - Destination folder
     * @param range - Sequence number range (or UID range with useUid), e.g. "1:5"
     */
    copy = async (target: string, range: string, useUid = false): Promise<void> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, `${useUid ? "UID " : ""}COPY ${range} ${quote(target)}`)
        await this.stream!.readUntilTag(tag)
    }

    /**
     * Moves messages to another folder (requires the MOVE capability).
     * @param target - Destination folder
     * @param range - Sequence number range (or UID range with useUid), e.g. "1:5"
     */
    move = async (target: string, range: string, useUid = false): Promise<void> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, `${useUid ? "UID " : ""}MOVE ${range} ${quote(target)}`)
        await this.stream!.readUntilTag(tag)
    }

    /**
     * Requests mailbox status information.
     * @param folder - Folder to check
     * @param items - Which items to request (defaults to MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN)
     */
    status = async (
        folder: string,
        items: Array<"MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN"> = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"]
    ): Promise<Record<string, number>> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, `STATUS ${quote(folder)} (${items.join(" ")})`)
        const { items: responses } = await this.stream!.readUntilTag(tag)

        for (const item of responses) {
            if (!item.line.startsWith("* STATUS")) continue
            const list = parseImapList(item.line.slice("* STATUS".length).trim())
            const kv = list[1]
            if (!Array.isArray(kv)) continue
            const result: Record<string, number> = {}
            for (let i = 0; i < kv.length; i += 2) {
                result[String(kv[i]).toLowerCase()] = parseInt(String(kv[i + 1]))
            }
            return result
        }

        throw new Error("No STATUS response received", { cause: responses })
    }

    /**
     * Appends a message to a folder.
     * @param folder - Destination folder
     * @param message - Full raw message (headers + body), as string or bytes
     * @param flags - Flags to set on the appended message, e.g. ["Seen"]
     * @param internalDate - Internal date of the message
     */
    append = async (folder: string, message: string | Uint8Array, flags?: string[], internalDate?: Date): Promise<void> => {
        this.requireConnection()

        const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
        const flagStr = flags?.length
            ? ` (${flags.map(f => f.startsWith("\\") ? f : `\\${f}`).join(" ")})`
            : ""
        const dateStr = internalDate ? ` "${formatInternalDate(internalDate)}"` : ""

        const tag = this.nextTag()
        await this.send(tag, `APPEND ${quote(folder)}${flagStr}${dateStr} {${bytes.length}}`)
        await this.stream!.readUntilTag(tag, { continuation: true })

        await this.writer!.write(bytes)
        await this.writer!.write(new TextEncoder().encode("\r\n"))
        await this.stream!.readUntilTag(tag)
    }

    /**
     * Requests a "checkpoint" on the server, a.k.a requests that the server
     * does some housekeeping. Almost never used, but exists in the RFC 3501
     * spec. Removed in the RFC 9051 spec, however most providers still
     * support it.
     */
    check = async (): Promise<string[]> => {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, "CHECK")
        const { items } = await this.stream!.readUntilTag(tag)
        return items.map(i => i.line)
    }

    /**
     * Logs the user out of the IMAP session and closes the socket.
     */
    logout = async (): Promise<boolean> => {
        this.requireConnection()

        try {
            const tag = this.nextTag()
            await this.send(tag, "LOGOUT")
            await this.stream!.readUntilTag(tag)
        } catch {
            // Socket might already be closed by the server; still try to close locally
        }

        try {
            await this.socket!.close()
        } catch { /* already closed */ }

        this.socket = null
        this.stream = null
        this.writer = null
        this.selectedFolder = ""

        return true
    }

    /** Alias of logout() */
    close = async (): Promise<boolean> => this.logout()
}
