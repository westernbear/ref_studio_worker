declare module "better-sqlite3" {
  interface Statement<Parameters extends readonly unknown[] = readonly unknown[], Result = unknown> {
    run(...parameters: Parameters): { changes: number; lastInsertRowid: number | bigint }
    get(...parameters: Parameters): Result | undefined
    all(...parameters: Parameters): Result[]
  }
  export default class Database {
    constructor(filename: string, options?: { timeout?: number })
    exec(sql: string): void
    prepare<Parameters extends readonly unknown[] = readonly unknown[], Result = unknown>(sql: string): Statement<Parameters, Result>
    close(): void
    pragma(sql: string, options?: { simple?: boolean }): unknown
  }
}
