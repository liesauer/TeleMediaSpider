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
            this.instance._db = new DatabaseConstructor(DataDir() + '/database.db', {
                nativeBinding: this.getNativeBinding(),
            });

            this.instance.initTable();
        }

        return this.instance;
    }

    private static getNativeBinding() {
        const better_sqlite3_version = '11.6.0';
        const nodejs_runtime_version = '108';

        // https://nodejs.cn/api/process.html#processplatform
        const platform = process.platform;
        // https://nodejs.cn/api/process.html#processarch
        const arch = process.arch;

        const path = __dirname + `/better-sqlite3/better-sqlite3-v${better_sqlite3_version}-node-v${nodejs_runtime_version}-${platform}-${arch}/build/Release/better_sqlite3.node`;

        return path;
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
