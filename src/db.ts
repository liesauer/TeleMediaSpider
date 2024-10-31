import DatabaseConstructor, { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';

import { DataDir } from './functions';

export class Db {
    private static instance: Db;
    private _db: Database;

    private __construct() {}

    public static db() {
        if (!this.instance) {
            this.instance = new Db();
            this.instance._db = new DatabaseConstructor(DataDir() + '/database.db');

            this.instance.initTable();
        }

        return this.instance;
    }

    private initTable() {
        if (!this.tableExists('channel')) {
            const sql = readFileSync(__dirname + '/channel.sql', 'utf-8');

            this._db.exec(sql);
        }

        if (!this.tableExists('message')) {
            const sql = readFileSync(__dirname + '/message.sql', 'utf-8');

            this._db.exec(sql);
        }
    }

    public tableExists(table: string) {
        return !!this.prepareGet("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=@name", {
            name: table,
        })?.['count'];
    }

    public dropTable(table: string) {
        this._db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }

    public emptyTable(table: string) {
        this.prepareRun(`DELETE FROM "${table}"`);
    }

    public prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(sql: string) {
        return this._db.prepare<BindParameters, Result>(sql);
    }

    public prepareRun(sql: string, ...params) {
        return this._db.prepare(sql).run(...params);
    }

    public prepareGet(sql: string, ...params) {
        return this._db.prepare(sql).get(...params);
    }

    public prepareGetAll(sql: string, ...params) {
        return this._db.prepare(sql).all(...params);
    }

    public prepareGetIter(sql: string, ...params) {
        return this._db.prepare(sql).iterate(...params);
    }
}
