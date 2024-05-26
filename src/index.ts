import { Tonfig } from '@liesauer/tonfig';
import Cron from 'croner';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import input from 'input';
import mimetics from 'mimetics';
import minimist from 'minimist';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { DataDir, array2dictionary, waitForever } from './functions';

const argv = minimist(process.argv.slice(2));

let client: TelegramClient;
let tonfig: Tonfig;

let mainTimer: Cron;
let mediaSpiderTimer: Cron;

function workerErrorHandler(error: any, job: Cron) {
    console.error(`「${job.name}」任务过程中发生错误：\n${error}`);
};

async function getChannelInfos(client: TelegramClient) {
    const dialogs = await client.invoke(
        new Api.messages.GetDialogs({
            offsetPeer: new Api.InputPeerEmpty(),
            limit: 500,
        })
    ) as Exclude<Api.messages.TypeDialogs, Api.messages.DialogsNotModified>;

    const ids = dialogs.dialogs.map(v => v.peer).filter(v => v.className == "PeerChannel").map(v => v as Api.PeerChannel);

    const idsMap = array2dictionary(ids, (i, e) => {
        return { key: e.channelId.toString(), value: e };
    });

    const channels = await client.invoke(new Api.channels.GetChannels({
        id: ids,
    }));

    const chats = channels.chats.filter(v => v.className == "Channel").map(v => v as Api.Channel);

    const getTopics = (topics: Api.messages.ForumTopics) => {
        return topics.topics.filter(v => v.className == "ForumTopic").map(v => v as Api.ForumTopic).map(v => ({
            id:    v.id,
            title: v.title,
        }));
    };

    const infos = chats.map(chat => {
        return {
            id:       chat.id,
            peer:     idsMap[chat.id.toString()],
            title:    chat.title,
            forum:    chat.forum,
            username: chat.username,
            topics:   [] as ReturnType<typeof getTopics>,
        };
    });

    await Promise.allSettled(infos.filter(v => v.forum).map(async v => {
        return client.invoke(
            new Api.channels.GetForumTopics({
                channel: v.peer,
            })
        ).then(topics => ({ topics, channel: v }));
    })).then(results => {
        for (const result of results) {
            if (result.status == "rejected") continue;

            result.value.channel.topics = getTopics(result.value.topics);
        }
    });

    return infos;
}

/**
 * @param lastId 获取此条信息以后的信息
 * @param limit 每次获取多少信息（最大100）
 * @param newStrategy 当采集新的群组时（既没有`lastId`），历史信息采集策略
 * 
 * -1：采集所有历史信息，0：不采集任何历史信息，正数字：采集最后指定数量信息
 */
async function getChannelMessages(client: TelegramClient, channelId: string, lastId?: number, limit: number = 100, newStrategy: number = -1) {
    let messages: Api.MessageService[] = [];

    if (lastId) {
        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: -1 - limit,
                    offsetId: lastId,
                    limit: limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService).reverse());
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);
    } else if (newStrategy === -1) {
        let page = 0;

        do {
            // 第一次获取第一条信息，后面正常取
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    offsetId: 1,
                    addOffset: -1,
                    limit: 1,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService));
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    } else if (newStrategy >= 0) {
        let page = 0;

        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: page * limit,
                    limit: newStrategy === 0 ? 1 : limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                if (newStrategy !== 0) {
                    messages.push(..._messages.messages.map(v => v as Api.MessageService));
                }
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    }

    return { lastId: lastId || 0, messages };
}

async function downloadChannelMedia(client: TelegramClient, channelId: string, message: Api.MessageService, medias?: string[]) {
    const photo = message.photo as Api.Photo;
    const video = message.video as Api.Document;
    const audio = message.audio as Api.Document;

    const topicId = message.replyTo?.replyToTopId || message.replyToMsgId;

    // console.log(message.id);
    // console.log(topicId);
    // console.log(message.message);

    if (photo && (!medias || medias.includes('photo'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let noExt = false;

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                console.log(`媒体下载：${filename}，进度：${bytes}/${total}`);
            },
        });

        const ext = mimetics.parse(buffer)?.ext  || 'jpg';

        await writeFile(`${dir}/${filename}${!noExt ? '.' + ext : ''}`, buffer);
    }

    if (video && (!medias || medias.includes('video'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let noExt = false;

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                console.log(`媒体下载：${filename}，进度：${bytes}/${total}`);
            },
        });

        const ext = Object.keys(mimetics.mimeTypeMap).find(v => {
            return mimetics.mimeTypeMap[v] == video.mimeType;
        }) || 'mp4';

        await writeFile(`${dir}/${filename}${!noExt ? '.' + ext : ''}`, buffer);
    }

    if (audio && (!medias || medias.includes('audio'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let noExt = false;

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                console.log(`媒体下载：${filename}，进度：${bytes}/${total}`);
            },
        });

        const ext = Object.keys(mimetics.mimeTypeMap).find(v => {
            return mimetics.mimeTypeMap[v] == audio.mimeType;
        }) || 'mp3';

        await writeFile(`${dir}/${filename}${!noExt ? '.' + ext : ''}`, buffer);
    }
}

async function mediaSpider() {
    await client.connect();

    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    const listChannels = !!argv['list'];

    await getChannelInfos(client).then(async channels => {
        for (const channel of channels) {
            const channelId = channel.id.toString();

            if (listChannels) {
                console.log(`频道ID：${channel.id.toString()}`);
                console.log(`频道名：${channel.title}`);
                console.log('');
                continue;
            }

            if (!allowChannels.includes(channelId)) continue;

            const medias = tonfig.get(['spider', 'medias', channelId], '');

            if (!medias) {
                tonfig.set(['spider', 'medias', channelId], 'photo,video,audio');
                await tonfig.save();
            }

            const mediasArr = medias.split(',').map(v => v.trim());

            console.log(`抓取频道消息，频道ID：${channelId}`);

            const messages = await getChannelMessages(client, channelId, tonfig.get(['spider', 'lastIds', channelId], 0), undefined, -1);

            for (const message of messages.messages) {
                // console.log(message.id);
                // console.log(message.message);
                // console.log("\n\n");

                console.log(`解析频道消息，消息ID：${message.id}`);

                await downloadChannelMedia(client, channelId, message, mediasArr);

                tonfig.set(['spider', 'lastIds', channelId], message.id);
                await tonfig.save();

                console.log("\n");
            }
        }
    }).then(() => {
        if (listChannels) return waitForever();
    });
}

async function main() {
    tonfig = await Tonfig.loadFile(DataDir() + '/config.toml', {
        account: {
            apiId: 0,
            apiHash: '',
            session: '',
            account: '',
        },

        spider: {
            channels: [],
            lastIds: {},
            medias: {},
        },

        proxy: {
            ip: "127.0.0.1",
            port: 0,
            username: "",
            password: "",
            MTProxy: false,
            secret: "",
            socksType: 5,
            timeout: 2,
        },
    });

    await tonfig.save();

    const apiId = tonfig.get<number>("account.apiId");
    const apiHash = tonfig.get<string>("account.apiHash");
    const account = tonfig.get<string>("account.account");

    if (!apiId || !apiHash || !account) {
        console.warn('请编辑 data/config.toml 进行账号配置，并重启软件');
        await waitForever();
    }

    const proxy = {
        ip: tonfig.get<string>("proxy.ip", ""),
        port: tonfig.get<number>("proxy.port", 0),
        username: tonfig.get<string>("proxy.username", ""),
        password: tonfig.get<string>("proxy.password", ""),
        MTProxy: tonfig.get<boolean>("proxy.MTProxy", false),
        secret: tonfig.get<string>("proxy.secret", ""),
        socksType: tonfig.get<5 | 4>("proxy.socksType", 5),
        timeout: tonfig.get<number>("proxy.timeout", 2),
    };

    client = new TelegramClient(new StringSession(tonfig.get<string>("account.session", "")), apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
        proxy: proxy.ip && proxy.port ? proxy : undefined,
    });

    await client.start({
        phoneNumber: account,
        password: async () => await input.text("请输入密码："),
        phoneCode: async () => await input.text("请输入验证码："),
        onError: (err) => console.log(err),
    });

    if (!tonfig.get<string>("account.session")) {
        tonfig.set("account.session", <string><unknown>client.session.save());

        await tonfig.save();
    }

    if (mediaSpiderTimer) {
        mediaSpiderTimer.stop();
        mediaSpiderTimer = null;
    }

    mediaSpiderTimer = Cron("*/5 * * * * *", {
        name: 'mediaSpider',
        protect: true,
        catch: workerErrorHandler,
    }, async () => await mediaSpider());

    await waitForever();
}

mainTimer = Cron("*/5 * * * *", {
    name: 'main',
    protect: true,
    catch: workerErrorHandler,
}, async () => await main());

mainTimer.trigger();
