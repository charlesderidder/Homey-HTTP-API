declare module 'emailjs' {
  export interface SMTPClientOptions {
    host: string;
    port: number;
    ssl: boolean;
    tls: boolean;
    user: string;
    password: string;
  }

  export interface SMTPMessage {
    from: string;
    to: string;
    subject: string;
    text: string;
  }

  export interface SMTPConnection {
    close(force?: boolean): void;
  }

  export class SMTPClient {
    constructor(server: Partial<SMTPClientOptions>);
    readonly smtp: SMTPConnection;
    sendAsync(message: SMTPMessage): Promise<SMTPMessage>;
  }
}
