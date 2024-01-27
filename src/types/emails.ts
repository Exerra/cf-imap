/**
 * If the 'peek' boolean is true, fetched emails won't get the '\Seen' flag set. On by default.
 */
export type FetchEmailsProps = {
    folder: string,
    byteLimit?: number,
    limit: [number, number],
    // If true, reading the email won't set the "\Seen" flag
    peek?: boolean
}

export type Email = {
    from: string,
    to: string,
    subject: string,
    messageID: string,
    contentType: string,
    date: Date,
    raw: string,
    body: string
}

export type SearchEmailsProps = {
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
    header?: { // ? array
        key: string,
        value: string
    },
    keyword?: string,
    unkeyword?: string, // Mails that do not have the specified keyword flag set
    largerThan?: number, // ! when putting in the query, remove Than
    new?: boolean,
    not?: string, // Emails that don't have a specified string
    old?: boolean, // \Recent flag
    on?: Date, // Emails whose internal date (disregarding time and timezone) is within specified date
    or?: string[],
    recent?: boolean,
    seen?: boolean, // \Seen flag, if true: SEEN, if false: UNSEEN
    sentBefore?: Date,
    sentOn?: Date, // Emails whose date header (disregarding time and timezone) is within the specified date,
    sentSince?: Date, // Emails whose date header (disregarding time and timezone) is within or later than the specified date
    since?: Date, // Emails whose internal date (disregarding time and timezone) is within or later than the specified date
    smallerThan?: number, // ! when putting in the query, remove Than
    subject?: string,
    text?: string, // Emails that contain the specified string in the header or body of the email
    to?: string,
    uid?: string, // ! Note to self: investigate more about this. Also, supports a range (array? string with dash?)
}