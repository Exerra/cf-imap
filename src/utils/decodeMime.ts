// Generated with Claude 3.5 Sonnet
// Chat URL: https://beta.t3.chat/chat/2afb57d9-5510-4d67-bad6-b5548cc193f6 (Exerra-only)

const MIME_WORD_REGEX: RegExp = /=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g;

export const decodeMimeEncodedWords = (input: string): string => {
  return input.replace(
    MIME_WORD_REGEX,
    (
      _match: string,
      charset: string,
      enc: string,
      encodedText: string
    ): string => {
      const encoding = enc.toUpperCase();
      let decoded: string;

      if (encoding === "B") {
        // Base64
        const binaryStr = atob(encodedText);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        decoded = new TextDecoder(charset).decode(bytes);
      } else {
        // Q-encoding: underscore → space, then =HH → raw byte
        const withSpaces = encodedText.replace(/_/g, " ");
        const raw = withSpaces.replace(
          /=([A-Fa-f0-9]{2})/g,
          (_seq, hex) => String.fromCharCode(parseInt(hex, 16))
        );
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          bytes[i] = raw.charCodeAt(i);
        }
        decoded = new TextDecoder(charset).decode(bytes);
      }

      return decoded;
    }
  );
};