import { connect } from "cloudflare:sockets"
import type { Email, Attachment, FetchEmailsProps, SearchEmailsProps, MailboxInfo, Folder, Namespace, Options, CopyUidInfo, AppendResult } from "./types/emails"
import { ImapStream, ImapError } from "./utils/imapStream"
import type { ResponseItem } from "./utils/imapStream"
import { parseImapList, quote, formatInternalDate, splitResponseCodes, parseInternalDate, encodeMutf7, decodeMutf7 } from "./utils/imapList"
import { decodeMimeEncodedWords, bytesToBase64 } from "./utils/decodeMime"
import { parseHeaders, parseAddresses, parseMime, extractContent } from "./utils/mime"
import { buildSearchQuery } from "./utils/search"

export { ImapError }
export type { Options, Email, Attachment, FetchEmailsProps, SearchEmailsProps, MailboxInfo, Folder, Namespace, CopyUidInfo, AppendResult, ResponseItem }

const CAP_RE = /\[CAPABILITY ([^\]]*)\]/

function parseCapabilities(line: string): string[] | null {
    const m = CAP_RE.exec(line)
    return m ? m[1]!.trim().split(/\s+/).filter(Boolean) : null
}

/** Extracts the COPYUID response code ([COPYUID <uidvalidity> <src-set> <dst-set>]) from a tagged response line. */
function parseCopyUid(line: string): CopyUidInfo | null {
    const codes = /\[([^\]]*)\]/.exec(line)
    if (!codes) return null
    const tokens = splitResponseCodes(codes[1])
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i]!.toUpperCase() !== "COPYUID") continue
        return {
            uidValidity: parseInt(tokens[i + 1]!),
            sourceUIDs: tokens[i + 2] ?? "",
            destUIDs: tokens[i + 3] ?? ""
        }
    }
    return null
}

/** Extracts the APPENDUID response code ([APPENDUID <uidvalidity> <uid>]) from a tagged response line. */
function parseAppendUid(line: string): AppendResult | null {
    const codes = /\[([^\]]*)\]/.exec(line)
    if (!codes) return null
    const tokens = splitResponseCodes(codes[1])
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i]!.toUpperCase() !== "APPENDUID") continue
        return {
            uidValidity: parseInt(tokens[i + 1]!),
            uid: parseInt(tokens[i + 2]!)
        }
    }
    return null
}

/**
 * Decodes the XOAUTH2 failure challenge: a `+ <base64 JSON>` continuation
 * line carrying {status, schemes, scope} (Google's XOAUTH2 spec; RFC 7628
 * OAUTHBEARER is analogous). Returns a human-readable description.
 */
function decodeXoauth2Error(line: string): string {
    const b64 = line.slice(1).trim()
    try {
        const json = JSON.parse(atob(b64)) as { status?: string, schemes?: string, scope?: string } | null
        if (json && (json.status || json.schemes || json.scope)) {
            const parts: string[] = []
            if (json.status) parts.push(`status ${json.status}`)
            if (json.schemes) parts.push(`schemes ${json.schemes}`)
            if (json.scope) parts.push(`scope ${json.scope}`)
            const hint = json.status === "401" || json.status === "400"
                ? " — the access token is expired or invalid; refresh it (or re-run the OAuth flow) and reconnect"
                : ""
            return `OAuth2 error ${parts.join(", ")}${hint}`
        }
    } catch { /* not JSON — fall through */ }
    return `OAuth2 challenge: ${b64 || "(empty)"}`
}

export class CFImap {
    private options: Options
    private socket: ReturnType<typeof connect> | null = null
    private stream: ImapStream | null = null
    private writer: WritableStreamDefaultWriter<any> | null = null
    private tagCounter = 0
    private busy = false

    session: { id?: string, protocol?: string } = {}
    /** Capabilities advertised by the server, e.g. ["IMAP4rev2", "UIDPLUS"] */
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

    /** True when the session is using IMAP4rev2 semantics (RFC 9051). */
    private get isRev2(): boolean {
        return this.capabilities.includes("IMAP4rev2")
    }

    /**
     * IMAP4rev2 uses UTF-8 (Net-Unicode) mailbox names; IMAP4rev1 uses
     * modified UTF-7. Encode/decode accordingly based on the negotiated version.
     */
    private encodeMailboxName(name: string): string {
        return this.isRev2 ? name : encodeMutf7(name)
    }

    private decodeMailboxName(name: string): string {
        return this.isRev2 ? name : decodeMutf7(name)
    }

    /**
     * Serializes IMAP commands: only one command may be in flight at a time,
     * because responses are matched to tags. Nested command methods must use
     * the internal (unguarded) helpers instead.
     */
    private async command<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy) {
            throw new Error("Another IMAP command is already in progress. Wait for it to finish (or end IDLE with DONE) before issuing a new command.")
        }
        this.busy = true
        try {
            return await fn()
        } finally {
            this.busy = false
        }
    }

    /**
     * Connects to the IMAP server and authenticates. Must be run after
     * initialising the CFImap class, otherwise nothing will work.
     *
     * Handles, in order: greeting (incl. BYE rejection), STARTTLS (RFC 9051
     * §6.2.1), authentication (AUTHENTICATE XOAUTH2 with an OAuth token when
     * configured, otherwise AUTHENTICATE PLAIN with SASL-IR falling back to
     * LOGIN when the server allows it — RFC 9051 §6.2.2/§6.2.3) and
     * ENABLE IMAP4rev2 when the server advertises both versions (Appendix A).
     */
    connect = async (): Promise<void> => {
        await this.command(async () => {
            // Port 993 is the conventional Implicit TLS port (RFC 8314): TLS is
            // negotiated immediately, no STARTTLS exchange. Other ports use
            // opportunistic TLS via STARTTLS (RFC 9051 §6.2.1).
            const implicitTls = this.options.tls && this.options.port === 993

            const socketOptions: SocketOptions = { allowHalfOpen: true }
            if (implicitTls) socketOptions.secureTransport = "on"
            else if (this.options.tls) socketOptions.secureTransport = "starttls"

            let socket = await connect({ hostname: this.options.host, port: this.options.port }, socketOptions)

            this.socket = socket
            this.writer = socket.writable.getWriter()
            this.stream = new ImapStream(socket.readable.getReader(), this.options.timeoutMs)

            const greeting = await this.stream!.readItem()
            const greetingLine = greeting.line

            if (greetingLine.startsWith("* BYE")) {
                throw new Error(`IMAP server rejected the connection: ${greetingLine}`, { cause: greeting })
            }
            if (!greetingLine.startsWith("*")) {
                throw new Error(`Unexpected IMAP greeting: ${greetingLine}`, { cause: greeting })
            }

            const greetingCaps = parseCapabilities(greetingLine)
            if (greetingCaps) this.capabilities = greetingCaps

            if (this.options.tls && !implicitTls) {
                const tag = this.nextTag()
                await this.send(tag, "STARTTLS")
                const { tagged } = await this.stream!.readUntilTag(tag)

                const starttlsCaps = parseCapabilities(tagged.line)
                if (starttlsCaps) this.capabilities = starttlsCaps

                // The TLS handshake happens after the tagged OK; startTls()
                // only upgrades the socket (it does not negotiate STARTTLS).
                socket = socket.startTls()
                this.socket = socket
                this.writer = socket.writable.getWriter()
                this.stream = new ImapStream(socket.readable.getReader(), this.options.timeoutMs)

                // Capabilities may differ after TLS — RFC 9051 §6.2.1 requires
                // discarding cached capabilities and re-issuing CAPABILITY.
                await this.capabilityInternal()
            }

            // * PREAUTH means the session is already authenticated (e.g. TLS client certs)
            if (!greetingLine.startsWith("* PREAUTH")) {
                await this.authenticate()
            }

            // When a server advertises both IMAP4rev1 and IMAP4rev2, a client
            // that wants IMAP4rev2 behavior MUST issue ENABLE IMAP4rev2 (RFC 9051 Appendix A).
            if (this.capabilities.includes("IMAP4rev1") && this.capabilities.includes("IMAP4rev2")) {
                await this.enableInternal(["IMAP4rev2"])
            }

            const protocol = this.capabilities.find(c => c.toLowerCase().startsWith("imap4"))
            this.session = {
                id: /SESSIONID=<([^>]+)>/.exec(greetingLine)?.[1],
                protocol
            }
        })
    }

    /**
     * Authenticates the session.
     *
     * When an OAuth 2.0 access token is configured (auth.accessToken or
     * auth.getAccessToken) and the server advertises AUTH=XOAUTH2, the
     * XOAUTH2 SASL mechanism is used — required by Gmail, Microsoft 365 /
     * Outlook.com and other modern providers that refuse passwords.
     *
     * Otherwise: AUTHENTICATE PLAIN (with SASL initial response) when the
     * server advertises AUTH=PLAIN, falling back to LOGIN — the "last
     * resort" per RFC 9051 §6.2.3 — unless the server advertises
     * LOGINDISABLED, in which case LOGIN is forbidden.
     */
    private async authenticate(): Promise<void> {
        const auth = this.options.auth
        const supportsXoauth2 = this.capabilities.includes("AUTH=XOAUTH2")
        const hasToken = "accessToken" in auth || "getAccessToken" in auth

        if (supportsXoauth2 && hasToken) {
            await this.authenticateXoauth2()
            return
        }

        if (!("password" in auth)) {
            throw new Error("An OAuth access token (auth.accessToken / auth.getAccessToken) was provided, but the server does not advertise the AUTH=XOAUTH2 mechanism and there is no password to fall back to. Provide a password instead, or connect to a server that supports XOAUTH2.")
        }

        const loginDisabled = this.capabilities.includes("LOGINDISABLED")

        if (this.capabilities.includes("AUTH=PLAIN")) {
            const tag = this.nextTag()
            const initial = bytesToBase64(new TextEncoder().encode(`\u0000${auth.username}\u0000${auth.password}`))
            await this.send(tag, `AUTHENTICATE PLAIN ${initial}`)
            try {
                const { tagged } = await this.stream!.readUntilTag(tag)
                const caps = parseCapabilities(tagged.line)
                if (caps) this.capabilities = caps
                return
            } catch (e) {
                // Fall back to LOGIN unless the server forbids it. (A NO here
                // usually means bad credentials, a BAD that the mechanism or
                // SASL-IR isn't supported — LOGIN may still work either way.)
                if (loginDisabled || this.capabilities.includes("LOGINDISABLED")) throw e
            }
        } else if (loginDisabled) {
            const oauthHint = supportsXoauth2
                ? " The server requires OAuth 2.0 (AUTH=XOAUTH2) — Gmail and Microsoft accounts no longer accept passwords. Provide a token via auth.accessToken or auth.getAccessToken."
                : ""
            throw new Error(`The server advertises LOGINDISABLED and no usable authentication mechanism (AUTH=PLAIN) is available. Cannot authenticate.${oauthHint}`)
        }

        const tag = this.nextTag()
        await this.send(tag, `LOGIN ${quote(auth.username)} ${quote(auth.password)}`)
        try {
            const { tagged } = await this.stream!.readUntilTag(tag)

            const loginCaps = parseCapabilities(tagged.line)
            if (loginCaps) this.capabilities = loginCaps
        } catch (e) {
            if (supportsXoauth2 && e instanceof ImapError) {
                throw new ImapError(e.status, e.tag, `${e.messageText} (The server requires OAuth 2.0 (AUTH=XOAUTH2) — Gmail and Microsoft accounts no longer accept passwords. Provide a token via auth.accessToken or auth.getAccessToken.)`, e.untagged)
            }
            throw e
        }
    }

    /**
     * Authenticates via the XOAUTH2 SASL mechanism with an OAuth 2.0 access
     * token. Uses SASL-IR (RFC 4959) when advertised, otherwise answers the
     * server's challenge with the initial response.
     *
     * On failure the server sends a `+ <base64 JSON>` challenge (error
     * status/schemes/scope); per the XOAUTH2 protocol the client MUST
     * acknowledge it with an empty line before the server responds with the
     * tagged NO — without that acknowledgment the exchange deadlocks.
     */
    private async authenticateXoauth2(): Promise<void> {
        const auth = this.options.auth
        let token: string
        if ("accessToken" in auth) {
            token = auth.accessToken
        } else if ("getAccessToken" in auth) {
            token = await auth.getAccessToken()
        } else {
            throw new Error("No OAuth access token configured")
        }

        const initial = bytesToBase64(new TextEncoder().encode(`user=${auth.username}\u0001auth=Bearer ${token}\u0001\u0001`))
        const saslIr = this.capabilities.includes("SASL-IR")

        const tag = this.nextTag()

        if (saslIr) {
            await this.send(tag, `AUTHENTICATE XOAUTH2 ${initial}`)
        } else {
            // No SASL-IR: send the mechanism name first and answer the
            // server's continuation prompt with the initial response.
            await this.send(tag, "AUTHENTICATE XOAUTH2")
            await this.stream!.readUntilTag(tag, { continuation: true })
            await this.writer!.write(new TextEncoder().encode(`${initial}\r\n`))
        }

        // continuation: true short-circuits on a "+" line. After a SASL
        // initial response, a "+" can only be an XOAUTH2 failure challenge
        // (base64 JSON error): acknowledge it with an empty line, then read
        // the tagged NO and surface the decoded error.
        const { tagged } = await this.stream!.readUntilTag(tag, { continuation: true })

        if (tagged.line.startsWith("+")) {
            const oauthError = decodeXoauth2Error(tagged.line)
            await this.writer!.write(new TextEncoder().encode("\r\n"))
            try {
                await this.stream!.readUntilTag(tag)
            } catch (e) {
                if (e instanceof ImapError) {
                    throw new ImapError(e.status, e.tag, `${e.messageText} (${oauthError})`, e.untagged)
                }
                throw e
            }
            return
        }

        const caps = parseCapabilities(tagged.line)
        if (caps) this.capabilities = caps
    }

    /**
     * Enables IMAP extensions via the ENABLE command (RFC 9051 §6.3.1).
     * Only valid in the authenticated state, before any mailbox is selected.
     * @param capabilities - Capability names to enable, e.g. "IMAP4rev2" or ["CONDSTORE"]
     * @returns The capabilities the server confirmed as enabled
     */
    enable = async (capabilities: string | string[]): Promise<string[]> => {
        return this.command(() => this.enableInternal(Array.isArray(capabilities) ? capabilities : [capabilities]))
    }

    private async enableInternal(caps: string[]): Promise<string[]> {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, `ENABLE ${caps.join(" ")}`)
        const { items } = await this.stream!.readUntilTag(tag)

        const enabled: string[] = []
        for (const item of items) {
            if (!item.line.startsWith("* ENABLED")) continue
            enabled.push(...item.line.slice("* ENABLED".length).trim().split(/\s+/).filter(Boolean))
        }
        return enabled
    }

    /**
     * Issues the CAPABILITY command, updates this.capabilities and returns
     * the current list (RFC 9051 §6.1.1).
     */
    capability = async (): Promise<string[]> => {
        return this.command(() => this.capabilityInternal())
    }

    private async capabilityInternal(): Promise<string[]> {
        this.requireConnection()

        const tag = this.nextTag()
        await this.send(tag, "CAPABILITY")
        const { items } = await this.stream!.readUntilTag(tag)

        for (const item of items) {
            if (!item.line.startsWith("* CAPABILITY")) continue
            this.capabilities = item.line.slice("* CAPABILITY".length).trim().split(/\s+/).filter(Boolean)
        }
        return this.capabilities
    }

    /**
     * Sends NOOP — useful to keep the connection alive and to trigger
     * unsolicited updates. Returns the untagged responses received.
     */
    noop = async (): Promise<ResponseItem[]> => {
        return this.command(async () => {
            this.requireConnection()

            const tag = this.nextTag()
            await this.send(tag, "NOOP")
            const { items } = await this.stream!.readUntilTag(tag)
            return items
        })
    }

    /**
     * Returns the prefixes and hierarchy delimiters of the personal, other
     * and shared namespaces available to the logged in user.
     */
    getNamespaces = async (): Promise<{ personal: Namespace[], other: Namespace[], shared: Namespace[] }> => {
        return this.command(async () => {
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
                            prefix: this.decodeMailboxName(String(arr[0] ?? "")),
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
        })
    }

    /**
     * Returns all folders in the specified namespace along with their flags.
     * @param {string} namespace - From which namespace to list folders (usually "" or the prefix from getNamespaces())
     * @param {string} filter - Pattern filter, e.g. "*" or "INBOX*"
     */
    getFolders = async (namespace: string, filter = "*"): Promise<Folder[]> => {
        return this.command(async () => {
            this.requireConnection()

            const tag = this.nextTag()
            await this.send(tag, `LIST ${quote(this.encodeMailboxName(namespace))} ${quote(this.encodeMailboxName(filter))}`)
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
                    name: this.decodeMailboxName(name),
                    delimiter: list[1] === "NIL" ? "" : String(list[1]),
                    attributes
                })
            }

            return folders
        })
    }

    /**
     * SELECT (or EXAMINE when `examine` is true) a mailbox and parse the
     * untagged responses (EXISTS, FLAGS, UIDVALIDITY, PERMANENTFLAGS, ...).
     */
    private async selectOrExamine(folder: string, examine: boolean): Promise<MailboxInfo> {
        this.requireConnection()

        if (!folder) throw new Error("Folder not given")

        const tag = this.nextTag()
        await this.send(tag, `${examine ? "EXAMINE" : "SELECT"} ${quote(this.encodeMailboxName(folder))}`)
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
                else if (t === "HIGHESTMODSEQ") info.highestModSeq = parseInt(tokens[i + 1]!)
                else if (t === "NOMODSEQ") info.nomodSeq = true
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
     * Selects a folder for use in the email GET & FETCH functions. Must be
     * run before those commands (or pass the folder prop to fetchEmails()).
     * @param folder - Selectable folder
     */
    selectFolder = async (folder: string): Promise<MailboxInfo> => {
        return this.command(() => this.selectOrExamine(folder, false))
    }

    /**
     * Opens a mailbox read-only (RFC 9051 §6.3.3). Identical output to
     * selectFolder(), but no changes to the mailbox (including per-user
     * state such as flags) are permitted.
     * @param folder - Folder to examine
     */
    examine = async (folder: string): Promise<MailboxInfo> => {
        return this.command(() => this.selectOrExamine(folder, true))
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
        return this.command(async () => {
            this.requireConnection()

            if (folder && folder !== this.selectedFolder) {
                await this.selectOrExamine(folder, false)
            } else if (!folder) {
                this.requireFolder()
            }

            const range = Array.isArray(limit) ? limit.join(":") : String(limit)
            const bodyCommand = fetchBody
                ? `BODY${peek ? ".PEEK" : ""}[]${byteLimit ? `<0.${byteLimit}>` : ""}`
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
                    // Don't let the tagged completion response leak into the fetch data
                    if (/^\S+ (OK|NO|BAD)( |$)/.test(token)) break
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

                // Large bodies may be split into multiple BODY[]<origin>
                // literals — concatenate the chunks in order.
                const headerPart = parts.filter(p => p.section === "header").map(p => p.content).join("")
                const bodyPart = parts.filter(p => p.section === "body").map(p => p.content).join("")

                let rawMessage: string
                if (fetchBody && bodyPart) {
                    rawMessage = bodyPart
                } else {
                    rawMessage = ""
                }

                let headerStr: string
                if (fetchBody && rawMessage) {
                    const sepIdx = rawMessage.indexOf("\r\n\r\n")
                    headerStr = sepIdx === -1 ? rawMessage : rawMessage.slice(0, sepIdx)
                } else {
                    headerStr = headerPart
                }

                const headerMap = parseHeaders(headerStr)

                const email: Email = {
                    uid: uidMatch ? parseInt(uidMatch[1]) : NaN,
                    seq,
                    flags: flagsMatch
                        ? flagsMatch[1].split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
                        : [],
                    internalDate: dateMatch ? parseInternalDate(dateMatch[1]) : new Date(NaN),
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
        })
    }

    /**
     * Searches emails based on the props given. Returns sequence numbers
     * (or UIDs with useUid: true).
     *
     * Handles both the IMAP4rev1 "* SEARCH" response and the IMAP4rev2
     * "* ESEARCH" response (RFC 9051 §6.4.4).
     */
    searchEmails = async (props: SearchEmailsProps): Promise<number[]> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            if (!props) throw new Error("Props not given")

            const query = buildSearchQuery(props)
            if (!query) throw new Error("No search options given. You must specify at least one search option.")

            const tag = this.nextTag()
            await this.send(tag, `${props.useUid ? "UID " : ""}SEARCH ${query}`)
            const { items } = await this.stream!.readUntilTag(tag)

            const ids: number[] = []

            const addSet = (set: string) => {
                for (const part of set.split(",")) {
                    if (part === "") continue
                    if (part.includes(":")) {
                        const [a, b] = part.split(":").map(p => parseInt(p))
                        if (isNaN(a!) || isNaN(b!)) continue
                        for (let n = a!; n <= b!; n++) ids.push(n)
                    } else {
                        const n = parseInt(part)
                        if (!isNaN(n)) ids.push(n)
                    }
                }
            }

            for (const item of items) {
                const line = item.line

                // IMAP4rev1: "* SEARCH 1 2 3"
                if (line.startsWith("* SEARCH")) {
                    const parts = line.slice("* SEARCH".length).trim().split(/\s+/)
                    for (const part of parts) {
                        const n = parseInt(part)
                        if (!isNaN(n)) ids.push(n)
                    }
                    continue
                }

                // IMAP4rev2: "* ESEARCH (TAG "A2") [UID] ALL 1:3,5"
                if (line.startsWith("* ESEARCH")) {
                    const allMatch = /(?:^| )ALL ([^ ]*)/.exec(line)
                    if (allMatch) addSet(allMatch[1]!)
                }
            }

            return ids
        })
    }

    /**
     * Adds, removes or replaces flags on one or more messages.
     * @param target - Sequence number range (or UID range with useUid), e.g. "1:5" or "42"
     * @param flags - Flags without the backslash, e.g. ["Seen", "Flagged"]
     * @param mode - add (default), remove or replace
     */
    storeFlags = async (target: string, flags: string[], mode: "add" | "remove" | "replace" = "add", useUid = false): Promise<Array<{ seq: number, flags: string[] }>> => {
        return this.command(async () => {
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
        })
    }

    /**
     * Permanently removes messages marked with the \Deleted flag.
     * @param opts.range - Optional sequence/UID range to restrict expunging to.
     * @param opts.useUid - Use UID EXPUNGE (requires a range; only removes the expunged UIDs of the selected mailbox)
     */
    expunge = async (opts: { range?: string, useUid?: boolean } = {}): Promise<number[]> => {
        return this.command(async () => {
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
        })
    }

    /**
     * Copies messages to another folder.
     * @param target - Destination folder
     * @param range - Sequence number range (or UID range with useUid), e.g. "1:5"
     * @returns The COPYUID mapping (source/destination UIDs) if the server reports one
     */
    copy = async (target: string, range: string, useUid = false): Promise<CopyUidInfo | null> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            const tag = this.nextTag()
            await this.send(tag, `${useUid ? "UID " : ""}COPY ${range} ${quote(this.encodeMailboxName(target))}`)
            const { tagged } = await this.stream!.readUntilTag(tag)
            return parseCopyUid(tagged.line)
        })
    }

    /**
     * Moves messages to another folder (part of the base protocol in
     * IMAP4rev2; requires the MOVE capability on IMAP4rev1 servers).
     * @param target - Destination folder
     * @param range - Sequence number range (or UID range with useUid), e.g. "1:5"
     * @returns The COPYUID mapping (source/destination UIDs) if the server reports one
     */
    move = async (target: string, range: string, useUid = false): Promise<CopyUidInfo | null> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            const tag = this.nextTag()
            await this.send(tag, `${useUid ? "UID " : ""}MOVE ${range} ${quote(this.encodeMailboxName(target))}`)
            const { tagged } = await this.stream!.readUntilTag(tag)
            return parseCopyUid(tagged.line)
        })
    }

    /**
     * Requests mailbox status information.
     * @param folder - Folder to check
     * @param items - Which items to request (defaults to MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN;
     *                IMAP4rev2 also supports DELETED and SIZE)
     */
    status = async (
        folder: string,
        items: Array<"MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN" | "DELETED" | "SIZE"> = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"]
    ): Promise<Record<string, number>> => {
        return this.command(async () => {
            this.requireConnection()

            const tag = this.nextTag()
            await this.send(tag, `STATUS ${quote(this.encodeMailboxName(folder))} (${items.join(" ")})`)
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
        })
    }

    /**
     * Appends a message to a folder.
     * @param folder - Destination folder
     * @param message - Full raw message (headers + body), as string or bytes
     * @param flags - Flags to set on the appended message, e.g. ["Seen"]
     * @param internalDate - Internal date of the message
     * @returns The APPENDUID result (UIDVALIDITY + assigned UID) if the server reports one
     */
    append = async (folder: string, message: string | Uint8Array, flags?: string[], internalDate?: Date): Promise<AppendResult | null> => {
        return this.command(async () => {
            this.requireConnection()

            const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
            const flagStr = flags?.length
                ? ` (${flags.map(f => f.startsWith("\\") ? f : `\\${f}`).join(" ")})`
                : ""
            const dateStr = internalDate ? ` "${formatInternalDate(internalDate)}"` : ""

            const tag = this.nextTag()
            await this.send(tag, `APPEND ${quote(this.encodeMailboxName(folder))}${flagStr}${dateStr} {${bytes.length}}`)
            await this.stream!.readUntilTag(tag, { continuation: true })

            await this.writer!.write(bytes)
            await this.writer!.write(new TextEncoder().encode("\r\n"))
            const { tagged } = await this.stream!.readUntilTag(tag)
            return parseAppendUid(tagged.line)
        })
    }

    /**
     * Requests a "checkpoint" on the server, a.k.a requests that the server
     * does some housekeeping. Almost never used.
     *
     * Note: CHECK was removed in RFC 9051 (IMAP4rev2) — it only works against
     * IMAP4rev1 servers. Use NOOP or IDLE instead.
     */
    check = async (): Promise<string[]> => {
        return this.command(async () => {
            this.requireConnection()

            if (this.isRev2) {
                throw new Error("CHECK was removed in IMAP4rev2 (RFC 9051). Use NOOP or IDLE instead.")
            }

            const tag = this.nextTag()
            await this.send(tag, "CHECK")
            const { items } = await this.stream!.readUntilTag(tag)
            return items.map(i => i.line)
        })
    }

    /**
     * Enters IDLE mode (RFC 9051 §6.3.13): the server pushes unsolicited
     * updates (EXISTS, EXPUNGE, FETCH, ...) as they happen. The callback is
     * invoked for each untagged response and may return false to leave IDLE.
     *
     * While IDLE is active, no other command may be issued on this connection.
     * Note that a read timeout (timeoutMs) ends IDLE when no updates arrive;
     * re-issue idle() to continue.
     */
    idle = async (onUpdate?: (item: ResponseItem) => boolean | void): Promise<void> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            const tag = this.nextTag()
            await this.send(tag, "IDLE")
            await this.stream!.readUntilTag(tag, { continuation: true })

            for (;;) {
                const item = await this.stream!.readItem()
                if (!item.line.startsWith("*")) continue
                const keepGoing = onUpdate?.(item)
                if (keepGoing === false) break
            }

            await this.send(tag, "DONE")
            await this.stream!.readUntilTag(tag)
        })
    }

    /**
     * Closes the selected mailbox (RFC 9051 §6.4.1): messages marked \Deleted
     * are permanently removed, then the mailbox is deselected.
     */
    closeMailbox = async (): Promise<void> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            const tag = this.nextTag()
            await this.send(tag, "CLOSE")
            await this.stream!.readUntilTag(tag)
            this.selectedFolder = ""
        })
    }

    /**
     * Deselects the currently selected mailbox without expunging
     * (RFC 9051 §6.4.2).
     */
    unselect = async (): Promise<void> => {
        return this.command(async () => {
            this.requireConnection()
            this.requireFolder()

            const tag = this.nextTag()
            await this.send(tag, "UNSELECT")
            await this.stream!.readUntilTag(tag)
            this.selectedFolder = ""
        })
    }

    /**
     * Logs the user out of the IMAP session and closes the socket.
     */
    logout = async (): Promise<boolean> => {
        return this.command(async () => {
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
        })
    }

    /** Alias of logout() */
    close = async (): Promise<boolean> => this.logout()
}
