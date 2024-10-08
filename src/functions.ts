import { Console } from 'console';
import { basename, dirname } from 'node:path';
import { Transform } from 'stream';
import runes from 'runes';

export function AppDir() {
    const executor = basename(process.execPath);

    const isRunningByNode = executor.toLowerCase() == "node.exe" || executor.toLowerCase() == "node";

    let root = '';

    if (isRunningByNode) {
        // 如果是Node运行的脚本，根目录就是src的上一层
        root = dirname(__dirname);
    } else {
        // 如果是打包程序，根目录就是程序根目录
        root = dirname(process.execPath);
    }

    return root;
}

export function DataDir() {
    return AppDir() + '/data';
}

export function getCurrentYmd() {
    const date = new Date();

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');

    const nowTime = `${year}-${month}-${day}`;

    return nowTime;
}

export function getCurrentTimeStamp() {
    return Math.floor(Date.now() / 1000);
}

export function getCurrentTimeStamp_MS() {
    return Date.now();
}

export function isEmptyObject(obj: any) {
    if (!obj) return true;

    if (Array.isArray(obj)) return obj.length == 0;

    for (const _ in obj) {
        return false;
    }

    return true;
}

export function array2dictionary<T = any, K extends string | number | symbol = string, T2 = T>(array: T[], transfer: (index: number, element: T) => ({ key: K, value: T2 })) {
    return array.reduce((dict, curr, index) => {
        const { key, value } = transfer(index, curr);
        dict[key] = value;

        return dict;
    }, <{ [I in K]: T2 }>{});
}

export function objectFirstKey(obj: any): string {
    if (!obj) return null;

    for (const key in obj) {
        return key;
    }

    return null;
}

export function notReject<T>(promise: PromiseSettledResult<T>) {
    return promise.status == "fulfilled" ? promise.value : null;
}

export function notResolve<T>(promise: PromiseSettledResult<T>) {
    return promise.status == "rejected" ? promise.reason : null;
}

export function waitTill(checker: () => boolean, checkTime: number): Promise<void> {
    return new Promise((resolve) => {
        let checking = false;
        let done = false;
        const token = setInterval(() => {
            if (checking) return;
            checking = true;
            if (!done && (!checker || checker())) {
                checking = false;
                done = true;
                clearInterval(token);
                resolve();
            }
            checking = false;
        }, checkTime);
    });
}

export function waitForever() {
    return new Promise<never>(() => {});
}

export async function countdown(countdown: number) : Promise<"timeout"> {
    return new Promise<void>((resolve, reject) => {
        setTimeout(resolve, countdown);
    }).then(() => 'timeout');
}

export async function retry<T = any>(promise: () => Promise<T>, maxRetries: number, retryPolicy?: (error: any) => boolean, retryDelay?: number): Promise<T> {
    return promise().catch<T>(async error => {
        let shouldRetry = maxRetries > 0;

        if (shouldRetry && retryPolicy) {
            shouldRetry &&= retryPolicy(error);
        }

        if (!shouldRetry) throw error;

        if (retryDelay) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, retryDelay);
            });
        }

        return retry(promise, maxRetries - 1, retryPolicy); 
    });
}

export function consoletable(input: any) {
    // @see https://stackoverflow.com/a/67859384
    const ts = new Transform({
        transform(chunk, enc, cb) {
            cb(null, chunk);
        }
    });
    const logger = new Console({ stdout: ts });
    logger.table(input);
    const table = (ts.read() || '').toString();
    let result = '';
    for (let row of table.split(/[\r\n]+/)) {
        let r = row.replace(/[^┬]*┬/, '┌');
        r = r.replace(/^├─*┼/, '├');
        r = r.replace(/│[^│]*/, '');
        r = r.replace(/^└─*┴/, '└');
        r = r.replace(/'/g, ' ');
        result += `${r}\n`;
    }

    return result;
}

export function ellipsisLeft(text: string, maxLength: number) {
    const chars = runes(text);

    if (!text || chars.length <= maxLength) return text;

    return '...' + chars.slice(chars.length - maxLength - 3).join('');
}

export function ellipsisMiddle(text: string, maxLength: number) {
    const chars = runes(text);

    if (!text || chars.length <= maxLength) return text;

    const halfLength = Math.floor((maxLength - 3) / 2);

    return chars.slice(0, halfLength).join('') + '...' + chars.slice(chars.length - halfLength).join('');
}
