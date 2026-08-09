export type ResponseItem = {
    line: string,
    /** Literal data if the line ended with a {N} marker, null otherwise */
    literal: Uint8Array | null
}

export class ImapError extends Error {
    status: "OK" | "NO" | "BAD"
    tag: string
    messageText: string
    untagged: ResponseItem[]

    constructor(status: "OK" | "NO" | "BAD", tag: string, messageText: string, untagged: ResponseItem[]) {
        super(`IMAP ${status} (${tag}): ${messageText}`)
        this.name = "ImapError"
        this.status = status
        this.tag = tag
        this.messageText = messageText
        this.untagged = untagged
    }
}

/**
 * Reads IMAP responses from a socket's readable stream.
 *
 * Handles:
 * - Responses split across arbitrary TCP chunks
 * - Literals ({N} markers) whose content may span multiple chunks and
 *   contain CRLF, parens or any other bytes
 * - Multi-byte UTF-8 sequences split across chunk boundaries
 */
export class ImapStream {
    private reader: ReadableStreamDefaultReader<any>
    private buffer = new Uint8Array(0)
    private textDecoder = new TextDecoder()
    private timeoutMs: number

    constructor(reader: ReadableStreamDefaultReader<any>, timeoutMs = 30000) {
        this.reader = reader
        this.timeoutMs = timeoutMs
    }

    private async fillBuffer(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`IMAP read timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
        })

        let result: ReadableStreamReadResult<any>
        try {
            result = await Promise.race([this.reader.read(), timeout])
        } catch (e) {
            this.close()
            throw e
        } finally {
            if (timer) clearTimeout(timer)
        }

        if (result.done) throw new Error("IMAP connection closed by server")

        const newBuf = new Uint8Array(this.buffer.length + result.value.length)
        newBuf.set(this.buffer)
        newBuf.set(result.value, this.buffer.length)
        this.buffer = newBuf
    }

    private indexOfCRLF(): number {
        for (let i = 0; i < this.buffer.length - 1; i++) {
            if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) return i
        }
        return -1
    }

    private close(): void {
        try {
            this.reader.cancel()
        } catch { /* already closed */ }
    }

    /**
     * Reads the next protocol element: either a plain line, or a line ending
     * with a {N} literal marker together with the N raw literal bytes.
     */
    async readItem(): Promise<ResponseItem> {
        for (;;) {
            const idx = this.indexOfCRLF()
            if (idx !== -1) {
                const lineBytes = this.buffer.slice(0, idx)
                this.buffer = this.buffer.slice(idx + 2)
                const line = this.textDecoder.decode(lineBytes, { stream: true })

                const marker = /\{(\d+)\+?\}$/.exec(line)
                if (marker) {
                    const n = parseInt(marker[1])
                    if (n === 0) return { line, literal: new Uint8Array(0) }
                    while (this.buffer.length < n) await this.fillBuffer()
                    const literal = this.buffer.slice(0, n)
                    this.buffer = this.buffer.slice(n)
                    return { line, literal }
                }

                return { line, literal: null }
            }
            await this.fillBuffer()
        }
    }

    /**
     * Reads items until the tagged completion response (tag OK/NO/BAD) arrives.
     * With continuation: true, stops at the first "+ " continuation line
     * instead (used for literal uploads).
     */
    async readUntilTag(tag: string, opts: { continuation?: boolean } = {}): Promise<{ items: ResponseItem[], tagged: ResponseItem }> {
        const items: ResponseItem[] = []

        for (;;) {
            const item = await this.readItem()
            const line = item.line

            if (opts.continuation && line.startsWith("+")) {
                return { items, tagged: item }
            }

            if (line.startsWith(`${tag} `)) {
                const rest = line.slice(tag.length).trim()
                const m = /^(OK|NO|BAD)(?: (.*))?$/.exec(rest)
                if (m) {
                    if (m[1] === "OK") return { items, tagged: item }
                    throw new ImapError(m[1] as "NO" | "BAD", tag, m[2] ?? "", items)
                }
            }

            items.push(item)
        }
    }
}
