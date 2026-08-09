import { describe, expect, test } from "bun:test"
import { ImapStream, ImapError } from "../src/utils/imapStream"

// Deterministic: each read() returns exactly one chunk, in order
const toStream = (chunks: (string | Uint8Array)[]): ReadableStream => new ReadableStream({
    start(controller) {
        for (const c of chunks) {
            controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c)
        }
        controller.close()
    }
})

describe("ImapStream", () => {
    test("reads a single line", async () => {
        const s = new ImapStream(toStream(["* OK ready\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* OK ready")
        expect(item.literal).toBeNull()
    })

    test("reads a line split across chunks", async () => {
        const s = new ImapStream(toStream(["* OK ", "ready", "\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* OK ready")
    })

    test("decodes multi-byte UTF-8 split across chunks", async () => {
        const s = new ImapStream(toStream([new Uint8Array([0x2a, 0x20, 0xc3]), new Uint8Array([0xa4, 0x0d, 0x0a])]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* ä")
    })

    test("reads a literal spanning chunks", async () => {
        const s = new ImapStream(toStream([
            "* 1 FETCH (BODY[] {5}\r\n",
            new Uint8Array([0x68, 0x65]),
            new Uint8Array([0x6c, 0x6c, 0x6f]),
            ")\r\n"
        ]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* 1 FETCH (BODY[] {5}")
        expect(new TextDecoder().decode(item.literal)).toBe("hello")
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("reads an empty literal", async () => {
        const s = new ImapStream(toStream(["{0}\r\n)\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.literal!.length).toBe(0)
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("literal content containing CRLF is not split", async () => {
        const s = new ImapStream(toStream(["* 1 FETCH (BODY[] {9}\r\n", "a\r\nb\r\nc\r\n", ")\r\n"]).getReader())
        const item = await s.readItem()
        expect(new TextDecoder().decode(item.literal)).toBe("a\r\nb\r\nc\r\n")
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("readUntilTag collects untagged items and returns on OK", async () => {
        const s = new ImapStream(toStream([
            "* FLAGS (\\Seen \\Deleted)\r\n",
            "* 3 EXISTS\r\n",
            "A1 OK [UIDVALIDITY 5] completed\r\n"
        ]).getReader())
        const { items, tagged } = await s.readUntilTag("A1")
        expect(items.map(i => i.line)).toEqual(["* FLAGS (\\Seen \\Deleted)", "* 3 EXISTS"])
        expect(tagged.line).toBe("A1 OK [UIDVALIDITY 5] completed")
    })

    test("readUntilTag throws ImapError on NO", async () => {
        const s = new ImapStream(toStream(["A1 NO Login failed\r\n"]).getReader())
        const p = s.readUntilTag("A1")
        await expect(p).rejects.toThrow(ImapError)
        await expect(p).rejects.toThrow(/Login failed/)
    })

    test("readUntilTag with continuation stops at + line", async () => {
        const s = new ImapStream(toStream(["A1 APPEND INBOX\r\n", "+ Ready for literal data\r\n"]).getReader())
        const { items, tagged } = await s.readUntilTag("A1", { continuation: true })
        expect(items.map(i => i.line)).toEqual(["A1 APPEND INBOX"])
        expect(tagged.line).toStartWith("+")
    })

    test("does not mistake A10 for tag A1", async () => {
        const s = new ImapStream(toStream(["A10 OK wrong tag\r\n", "A1 OK right tag\r\n"]).getReader())
        const { items } = await s.readUntilTag("A1")
        expect(items.map(i => i.line)).toEqual(["A10 OK wrong tag"])
    })

    test("times out when the server never responds", async () => {
        const s = new ImapStream(new ReadableStream({ pull() {} }).getReader(), 50)
        await expect(s.readItem()).rejects.toThrow(/timed out/)
    })

    test("throws when the connection closes", async () => {
        const s = new ImapStream(new ReadableStream({ start(controller) { controller.close() } }).getReader())
        await expect(s.readItem()).rejects.toThrow(/closed by server/)
    })
})
