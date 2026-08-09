import { describe, expect, test } from "bun:test"
import {
    decodeMimeEncodedWords,
    decodeBytes,
    base64ToBytes,
    bytesToBase64,
    decodeQuotedPrintable
} from "../src/utils/decodeMime"

describe("decodeMimeEncodedWords", () => {
    test("decodes base64 encoded word", () => {
        expect(decodeMimeEncodedWords("=?utf-8?B?SGVsbG8gV29ybGQ=?=")).toBe("Hello World")
    })

    test("decodes Q encoded word with underscores", () => {
        expect(decodeMimeEncodedWords("=?utf-8?Q?Hello_World?=")).toBe("Hello World")
    })

    test("decodes Q encoded word with hex escapes", () => {
        expect(decodeMimeEncodedWords("=?utf-8?Q?J=C3=A4rjestys?=")).toBe("Järjestys")
    })

    test("decodes latin-1 base64 word", () => {
        expect(decodeMimeEncodedWords("=?iso-8859-1?B?SuRy?=")).toBe("Jär")
    })

    test("joins adjacent encoded words without whitespace", () => {
        expect(decodeMimeEncodedWords("=?utf-8?B?SGVsbG8=?= =?utf-8?B?V29ybGQ=?=")).toBe("HelloWorld")
    })

    test("keeps whitespace between encoded word and plain text", () => {
        expect(decodeMimeEncodedWords("Hello =?utf-8?B?V29ybGQ=?= again")).toBe("Hello World again")
    })

    test("returns input unchanged when no encoded words", () => {
        expect(decodeMimeEncodedWords("plain text")).toBe("plain text")
    })
})

describe("base64", () => {
    test("roundtrip", () => {
        const bytes = new TextEncoder().encode("Hello, World! 123")
        expect(bytesToBase64(base64ToBytes(bytesToBase64(bytes)))).toBe(bytesToBase64(bytes))
    })

    test("handles whitespace in input", () => {
        expect(new TextDecoder().decode(base64ToBytes("SGVs\r\nbG8="))).toBe("Hello")
    })
})

describe("decodeQuotedPrintable", () => {
    test("decodes hex escapes", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("J=C3=A4rjestys"))).toBe("Järjestys")
    })

    test("removes soft line breaks", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("soft=\r\nbreak"))).toBe("softbreak")
    })

    test("keeps literal equals", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("a=b"))).toBe("a=b")
    })
})

describe("decodeBytes", () => {
    test("utf-8", () => {
        expect(decodeBytes(new TextEncoder().encode("héllo"))).toBe("héllo")
    })

    test("latin-1 high bytes map directly", () => {
        const bytes = Uint8Array.from([0x4a, 0x65, 0x6d, 0xe4, 0x72])
        expect(decodeBytes(bytes, "iso-8859-1")).toBe("Jemär")
    })

    test("windows-1252 maps smart quotes", () => {
        const bytes = Uint8Array.from([0x93, 0x68, 0x69, 0x94])
        expect(decodeBytes(bytes, "windows-1252")).toBe("\u201Chi\u201D")
    })

    test("unknown charset falls back to latin-1", () => {
        const bytes = Uint8Array.from([0x61, 0xe4])
        expect(decodeBytes(bytes, "x-mystery-charset")).toBe("aä")
    })
})
