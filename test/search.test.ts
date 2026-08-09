import { describe, expect, test } from "bun:test"
import { buildSearchQuery } from "../src/utils/search"
import { parseImapList, quoteIfNeeded, splitResponseCodes, formatImapDate, formatInternalDate } from "../src/utils/imapList"

describe("buildSearchQuery", () => {
    test("all", () => {
        expect(buildSearchQuery({ all: true })).toBe("ALL")
    })

    test("boolean flags", () => {
        expect(buildSearchQuery({ seen: true })).toBe("SEEN")
        expect(buildSearchQuery({ seen: false })).toBe("UNSEEN")
        expect(buildSearchQuery({ answered: true, deleted: false })).toBe("ANSWERED UNDELETED")
    })

    test("string keys are quoted when needed", () => {
        expect(buildSearchQuery({ from: "bob@x.c" })).toBe("FROM bob@x.c")
        expect(buildSearchQuery({ subject: "hello world" })).toBe('SUBJECT "hello world"')
    })

    test("dates", () => {
        expect(buildSearchQuery({ before: new Date(2026, 7, 9) })).toBe("BEFORE 9-Aug-2026")
        expect(buildSearchQuery({ sentSince: new Date(2024, 0, 1) })).toBe("SENTSINCE 1-Jan-2024")
    })

    test("sizes", () => {
        expect(buildSearchQuery({ largerThan: 1000 })).toBe("LARGER 1000")
        expect(buildSearchQuery({ smallerThan: 50 })).toBe("SMALLER 50")
    })

    test("header", () => {
        expect(buildSearchQuery({ header: { key: "X-Custom", value: "abc" } })).toBe('HEADER "X-Custom" "abc"')
    })

    test("or chain", () => {
        expect(buildSearchQuery({ or: [["from", "a@b.c"], ["from", "c@d.e"]] }))
            .toBe("OR (FROM a@b.c) (FROM c@d.e)")
        expect(buildSearchQuery({ or: [["from", "a"], ["from", "b"], ["from", "c"]] }))
            .toBe('OR (FROM a) (OR (FROM b) (FROM c))')
    })

    test("not", () => {
        expect(buildSearchQuery({ not: "spam" })).toBe("NOT TEXT spam")
    })

    test("keyword and uid", () => {
        expect(buildSearchQuery({ keyword: "Important" })).toBe("KEYWORD Important")
        expect(buildSearchQuery({ uid: "1:5" })).toBe("UID 1:5")
    })

    test("returns null when nothing given", () => {
        expect(buildSearchQuery({})).toBeNull()
    })
})

describe("parseImapList", () => {
    test("nested lists and quoted strings", () => {
        expect(parseImapList('(("" "/") ("Archive" "/"))')).toEqual([[["", "/"], ["Archive", "/"]]])
        expect(parseImapList('(("" "/")) NIL NIL')).toEqual([[["", "/"]], "NIL", "NIL"])
    })
    test("flags list", () => {
        expect(parseImapList('(\\Answered \\Flagged)')).toEqual([["\\Answered", "\\Flagged"]])
    })

    test("status response", () => {
        expect(parseImapList('"INBOX" (MESSAGES 231 UIDNEXT 44292)')).toEqual(["INBOX", ["MESSAGES", "231", "UIDNEXT", "44292"]])
    })

    test("empty list", () => {
        expect(parseImapList("()")).toEqual([[]])
    })
})

describe("quoteIfNeeded", () => {
    test("atoms pass through", () => {
        expect(quoteIfNeeded("hello")).toBe("hello")
        expect(quoteIfNeeded("bob@x.c")).toBe("bob@x.c")
    })
    test("strings with specials are quoted", () => {
        expect(quoteIfNeeded("hello world")).toBe('"hello world"')
        expect(quoteIfNeeded('say "hi"')).toBe('"say \\"hi\\""')
        expect(quoteIfNeeded("back\\slash")).toBe('"back\\\\slash"')
        expect(quoteIfNeeded("a*b")).toBe('"a*b"')
    })
    test("empty string is quoted", () => {
        expect(quoteIfNeeded("")).toBe('""')
    })
})

describe("splitResponseCodes", () => {
    test("keeps parenthesized groups together", () => {
        expect(splitResponseCodes("UIDVALIDITY 3857529045 UIDNEXT 4392")).toEqual(["UIDVALIDITY", "3857529045", "UIDNEXT", "4392"])
        expect(splitResponseCodes("PERMANENTFLAGS (\\Seen \\Deleted \\*) UIDVALIDITY 1")).toEqual([
            "PERMANENTFLAGS", "(\\Seen \\Deleted \\*)", "UIDVALIDITY", "1"
        ])
    })
})

describe("date formatting", () => {
    test("imap search date", () => {
        expect(formatImapDate(new Date(2026, 2, 5))).toBe("5-Mar-2026")
    })
    test("internal date", () => {
        const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
        expect(formatInternalDate(d)).toBe("02-Jan-2026 03:04:05 +0000")
    })
})
