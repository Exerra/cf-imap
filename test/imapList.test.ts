import { describe, expect, test } from "bun:test"
import { parseInternalDate, encodeMutf7, decodeMutf7 } from "../src/utils/imapList"

describe("parseInternalDate", () => {
    test("parses RFC 9051 date-time format", () => {
        const d = parseInternalDate("17-Jul-1996 02:44:25 -0700")
        expect(d.toISOString()).toBe("1996-07-17T09:44:25.000Z")
    })

    test("handles positive offsets", () => {
        const d = parseInternalDate("2-Jan-2026 03:04:05 +0530")
        expect(d.toISOString()).toBe("2026-01-01T21:34:05.000Z")
    })

    test("handles zero offsets and single-digit day/hour", () => {
        const d = parseInternalDate("9-Aug-2026 9:05:01 +0000")
        expect(d.toISOString()).toBe("2026-08-09T09:05:01.000Z")
    })

    test("returns invalid date for garbage", () => {
        expect(isNaN(parseInternalDate("not a date").valueOf())).toBe(true)
        expect(isNaN(parseInternalDate("17-Jul-1996 02:44:25").valueOf())).toBe(true)
        expect(isNaN(parseInternalDate("17-Xyz-1996 02:44:25 +0000").valueOf())).toBe(true)
    })
})

describe("mUTF-7 (RFC 2152)", () => {
    test("RFC 2152 §5 example", () => {
        expect(encodeMutf7("~peter/mail/台北/日本語")).toBe("~peter/mail/&U,BTFw-/&ZeVnLIqe-")
    })

    test("decode roundtrip", () => {
        const input = "~peter/mail/台北/日本語"
        expect(decodeMutf7(encodeMutf7(input))).toBe(input)
        expect(decodeMutf7("&U,BTFw-")).toBe("台北")
    })

    test("passes through ASCII and escapes ampersands", () => {
        expect(encodeMutf7("INBOX")).toBe("INBOX")
        expect(encodeMutf7("A&B")).toBe("A&-B")
        expect(decodeMutf7("A&-B")).toBe("A&B")
        expect(decodeMutf7("INBOX")).toBe("INBOX")
    })

    test("handles surrogate pairs (emoji)", () => {
        const input = "inbox-📧"
        expect(decodeMutf7(encodeMutf7(input))).toBe(input)
    })
})
