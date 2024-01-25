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
    body: string
}