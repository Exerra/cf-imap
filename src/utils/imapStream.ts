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
    /**
     * The in-flight reader.read() promise. Never issue a second read() while
     * one is pending (the stream throws); on a read timeout the pending
     * promise is kept here and reused by the next read, so its data is never
     * lost and the stream stays consistent.
     */
    private pendingRead: Promise<ReadableStreamReadResult<any>> | null = null

    constructor(reader: ReadableStreamDefaultReader<any>, timeoutMs = 30000) {
        this.reader = reader
        this.timeoutMs = timeoutMs
    }

    private nextRead(): Promise<ReadableStreamReadResult<any>> {
        if (!this.pendingRead) {
            const read = this.reader.read()
            this.pendingRead = read.catch(e => {
                this.pendingRead = null
                throw e
            })
        }
        return this.pendingRead
    }

    /** Reads one chunk from the socket, waiting up to timeoutMs. */
    private async readChunk(): Promise<ReadableStreamReadResult<any> | "timeout"> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<"timeout">(resolve => {
            timer = setTimeout(() => resolve("timeout"), this.timeoutMs)
        })
        try {
            const result = await Promise.race([this.nextRead(), timeout])
            if (result === "timeout") return "timeout"
            this.pendingRead = null
            return result
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    private async fillBuffer(): Promise<void> {
        const result = await this.readChunk()
        if (result === "timeout") {
            this.close()
            throw new Error(`IMAP read timed out after ${this.timeoutMs}ms`)
        }
        this.appendChunk(result)
    }

    /** Like fillBuffer, but returns false on timeout instead of closing the reader. */
    private async fillBufferNoThrow(): Promise<boolean> {
        const result = await this.readChunk()
        if (result === "timeout") return false
        this.appendChunk(result)
        return true
    }

    private appendChunk(result: ReadableStreamReadResult<any>): void {
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
        const item = await this.readItemInternal(false)
        return item!
    }

    /**
     * Like readItem, but a read timeout while waiting for a line is not fatal:
     * returns null instead (the reader is NOT cancelled, the stream stays
     * usable). Timeouts while waiting for literal bytes are still fatal — a
     * partially-consumed literal leaves the stream corrupt. Used by IDLE,
     * where silence between responses is normal.
     */
    async readItemNoThrow(): Promise<ResponseItem | null> {
        return this.readItemInternal(true)
    }

    private async readItemInternal(noThrow: boolean): Promise<ResponseItem | null> {
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
            if (noThrow) {
                if (!(await this.fillBufferNoThrow())) return null
            } else {
                await this.fillBuffer()
            }
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
