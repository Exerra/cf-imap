export type Options = {
    host: string,
    port: number,
    /**
     * Use TLS. When true, port 993 (the conventional Implicit TLS port,
     * RFC 8314) negotiates TLS immediately; any other port uses opportunistic
     * TLS via the STARTTLS command (RFC 9051 §6.2.1).
     */
    tls: boolean,
    auth: {
        username: string,
        password: string
    },
    /** Read timeout for IMAP responses in milliseconds. Defaults to 30000. */
    timeoutMs?: number
}

/**
 * If the 'peek' boolean is true, fetched emails won't get the '\Seen' flag set. On by default.
 */
export type FetchEmailsProps = {
    /**
     * Range of sequence numbers to fetch, e.g. [1, 10]. Alternatively a single sequence number.
     */
    limit: [number, number] | number,
    /**
     * Folder to fetch from. If omitted, the folder selected via selectFolder() is used.
     * If provided and different from the selected folder, it will be selected automatically.
     */
    folder?: string,
    /**
     * If true (default), the full message body is fetched and parsed (headers, MIME parts, attachments).
     * If false, only the header fields are fetched.
     */
    fetchBody?: boolean,
    /**
     * Maximum size of the emails to fetch (optional, not recommended).
     */
    byteLimit?: number,
    /**
     * If true, limit is interpreted as a UID range (UID FETCH) and messages
     * are matched by UID. The uid field then carries the message UID; seq
     * always holds the sequence number in the selected folder.
     */
    useUid?: boolean,
    peek?: boolean
}

export type Attachment = {
    /** File name, if any */
    filename: string,
    /** MIME type of the attachment, e.g. "application/pdf" */
    mimeType: string,
    /** Size of the decoded content in bytes */
    size: number,
    /** Original Content-Transfer-Encoding, e.g. "base64" */
    encoding: string,
    /** Decoded content as a string (charset-decoded for text/*, byte-preserving otherwise) */
    content: string,
    /** Decoded content as a base64 string */
    contentBase64: string,
    contentId?: string,
    /** True if the attachment was marked inline (e.g. embedded images) */
    isInline: boolean
}

export type Email = {
    /** UID of the message */
    uid: number,
    /** Sequence number of the message in the selected folder */
    seq: number,
    /** Message flags without the backslash, e.g. ["Seen", "Flagged"] */
    flags: string[],
    /** INTERNALDATE of the message */
    internalDate: Date,
    /** RFC822.SIZE of the message in bytes */
    size: number,
    from: string[],
    to: string[],
    cc: string[],
    subject: string,
    messageID: string,
    contentType: string,
    /** All parsed headers (lowercased names, MIME-words decoded, folded lines unfolded) */
    headers: Record<string, string>,
    /** The raw header section as received */
    rawHeaders: string,
    body: {
        /** Decoded text/plain body, if present */
        text?: string,
        /** Decoded text/html body, if present */
        html?: string,
        /** The raw body section as received (the full raw message when fetchBody is true) */
        raw: string
    },
    attachments: Attachment[],
    /** The full raw message (when fetchBody is true) or the raw header section */
    raw: string
}

export type Folder = {
    name: string,
    delimiter: string,
    attributes: string[]
}

export type Namespace = {
    prefix: string,
    delimiter: string
}

export type MailboxInfo = {
    /** Number of messages (EXISTS) */
    emails: number,
    /** Number of recent messages (deprecated in IMAP4rev2, kept for IMAP4rev1 servers) */
    recent: number,
    unseen?: number,
    uidNext?: number,
    uidValidity?: number,
    /** Highest modification sequence (CONDSTORE, RFC 7162), if advertised */
    highestModSeq?: number,
    /** True if the mailbox does not support modification sequences (CONDSTORE) */
    nomodSeq?: boolean,
    /** Flags supported by the mailbox */
    flags: string[],
    /** Flags that can be permanently stored, e.g. ["Seen", "Deleted", "*"] */
    permanentFlags: string[],
    /** True if the mailbox was opened read-only */
    readOnly: boolean
}

export type SearchEmailsProps = {
    /** If true, run UID SEARCH and return UIDs instead of sequence numbers */
    useUid?: boolean,
    all?: boolean,
    answered?: boolean, // if true: ANSWERED, if false: UNANSWERED
    bcc?: string,
    before?: Date,
    body?: string,
    cc?: string,
    deleted?: boolean, // \Deleted flag, if true: DELETED, if false: UNDELETED
    draft?: boolean, // \Draft flag, if true: DRAFT, if false: UNDRAFT
    flagged?: boolean, // \Flagged flag, if true: FLAGGED, if false: UNFLAGGED
    from?: string,
    header?: {
        key: string,
        value: string
    },
    keyword?: string,
    unkeyword?: string, // Mails that do not have the specified keyword flag set
    largerThan?: number,
    new?: boolean,
    /** Emails whose text doesn't contain the given string */
    not?: string,
    old?: boolean, // \Recent flag
    on?: Date, // Emails whose internal date (disregarding time and timezone) is within specified date
    /** List of [searchKey, value] pairs combined with OR */
    or?: Array<[string, string]>,
    recent?: boolean,
    seen?: boolean, // \Seen flag, if true: SEEN, if false: UNSEEN
    sentBefore?: Date,
    sentOn?: Date, // Emails whose date header (disregarding time and timezone) is within the specified date,
    sentSince?: Date, // Emails whose date header (disregarding time and timezone) is within or later than the specified date
    since?: Date, // Emails whose internal date (disregarding time and timezone) is within or later than the specified date
    smallerThan?: number,
    subject?: string,
    text?: string, // Emails that contain the specified string in the header or body of the email
    to?: string,
    uid?: string // Supports a single UID or a range, e.g. "5" or "1:10"
}

/**
 * UID mapping reported by the COPYUID response code (RFC 9051 §7.1) on
 * successful COPY and MOVE (and UID COPY / UID MOVE) commands.
 */
export type CopyUidInfo = {
    /** UIDVALIDITY of the destination mailbox */
    uidValidity: number,
    /** UID set of the source messages, as reported by the server */
    sourceUIDs: string,
    /** UID set of the messages in the destination mailbox */
    destUIDs: string
}

/** Result of APPEND, from the APPENDUID response code (RFC 9051 §7.1). */
export type AppendResult = {
    /** UIDVALIDITY of the destination mailbox */
    uidValidity: number,
    /** UID assigned to the appended message */
    uid: number
}
