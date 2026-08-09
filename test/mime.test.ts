import { describe, expect, test } from "bun:test"
import { parseHeaders, parseAddresses, parseMime, extractContent } from "../src/utils/mime"

const enc = (s: string) => new TextEncoder().encode(s)

describe("parseHeaders", () => {
    test("parses and lowercases header names", () => {
        const h = parseHeaders("Subject: Hello\r\nFrom: a@b.c\r\n")
        expect(h).toEqual({ subject: "Hello", from: "a@b.c" })
    })

    test("unfolds folded headers", () => {
        const h = parseHeaders("Subject: This is\r\n a very long\r\n subject\r\n")
        expect(h.subject).toBe("This is a very long subject")
    })

    test("decodes MIME words", () => {
        const h = parseHeaders("Subject: =?utf-8?B?SGVsbG8=?=\r\n")
        expect(h.subject).toBe("Hello")
    })
})

describe("parseAddresses", () => {
    test("splits comma separated addresses", () => {
        expect(parseAddresses('"Jane Doe" <jane@x.c>, bob@y.c')).toEqual(['"Jane Doe" <jane@x.c>', "bob@y.c"])
    })

    test("does not split on commas inside angle brackets", () => {
        expect(parseAddresses('"A, B" <a@x.c>')).toEqual(['"A, B" <a@x.c>'])
    })

    test("returns empty array for empty input", () => {
        expect(parseAddresses("")).toEqual([])
    })
})

describe("parseMime", () => {
    test("parses a simple text/plain message", () => {
        const raw = "From: a@b.c\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHello body"
        const root = parseMime(enc(raw))
        expect(root.contentType).toBe("text/plain")
        expect(root.charset).toBe("UTF-8")
        const { text } = extractContent(root)
        expect(text).toBe("Hello body")
    })

    test("parses multipart/mixed with base64 attachment", () => {
        const raw = [
            "From: a@b.c",
            'Content-Type: multipart/mixed; boundary="BOUND"',
            "",
            "--BOUND",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            "Hello",
            "--BOUND",
            'Content-Type: application/pdf',
            'Content-Disposition: attachment; filename="doc.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            "SGVsbG8gUERG",
            "--BOUND--",
            ""
        ].join("\r\n")

        const root = parseMime(enc(raw))
        const { text, attachments } = extractContent(root)
        expect(text).toBe("Hello")
        expect(attachments).toHaveLength(1)
        expect(attachments[0]!.filename).toBe("doc.pdf")
        expect(attachments[0]!.mimeType).toBe("application/pdf")
        expect(attachments[0]!.content).toBe("SGVsbG8gUERG")
        expect(attachments[0]!.isInline).toBe(false)
    })

    test("parses nested multipart/alternative inside multipart/mixed", () => {
        const raw = [
            'Content-Type: multipart/mixed; boundary="OUTER"',
            "",
            "--OUTER",
            'Content-Type: multipart/alternative; boundary="INNER"',
            "",
            "--INNER",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            "plain version",
            "--INNER",
            "Content-Type: text/html; charset=UTF-8",
            "",
            "<b>html version</b>",
            "--INNER--",
            "",
            "--OUTER",
            'Content-Type: text/plain; charset=UTF-8',
            "",
            "Trailing part",
            "--OUTER--",
            ""
        ].join("\r\n")

        const root = parseMime(enc(raw))
        const { text, html, attachments } = extractContent(root)
        expect(text).toBe("plain version\nTrailing part")
        expect(html).toBe("<b>html version</b>")
        expect(attachments).toHaveLength(0)
    })

    test("decodes quoted-printable body with charset", () => {
        const raw = "Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nJ=E4r =E5r"
        const root = parseMime(enc(raw))
        const { text } = extractContent(root)
        expect(text).toBe("Jär år")
    })

    test("parses inline image with content-id", () => {
        const raw = [
            'Content-Type: multipart/related; boundary="REL"',
            "",
            "--REL",
            "Content-Type: text/html; charset=UTF-8",
            "",
            "<img src=\"cid:img1\">",
            "--REL",
            "Content-Type: image/png",
            "Content-ID: <img1>",
            "Content-Disposition: inline",
            "Content-Transfer-Encoding: base64",
            "",
            "iVBORw0KGgo=",
            "--REL--",
            ""
        ].join("\r\n")

        const root = parseMime(enc(raw))
        const { html, attachments } = extractContent(root)
        expect(html).toBe('<img src="cid:img1">')
        expect(attachments).toHaveLength(1)
        expect(attachments[0]!.contentId).toBe("img1")
        expect(attachments[0]!.isInline).toBe(true)
    })

    test("parses literal first boundary without preamble CRLF", () => {
        const raw = [
            'Content-Type: multipart/mixed; boundary="X"',
            "",
            "--X",
            "Content-Type: text/plain",
            "",
            "body",
            "--X--",
            ""
        ].join("\r\n").replace(/^Content-Type/, "Content-Type")

        const root = parseMime(enc(raw))
        const { text } = extractContent(root)
        expect(text).toBe("body")
    })

    test("handles 8bit latin-1 body", () => {
        const raw = "Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        const bodyBytes = Uint8Array.from([0x4a, 0x65, 0x6d, 0xe4, 0x72])
        const full = new Uint8Array(enc(raw).length + bodyBytes.length)
        full.set(enc(raw))
        full.set(bodyBytes, enc(raw).length)

        const root = parseMime(full)
        const { text } = extractContent(root)
        expect(text).toBe("Jemär")
    })
})
