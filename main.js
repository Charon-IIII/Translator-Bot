require("dotenv").config();

const {
    Client,
    GatewayIntentBits
} = require("discord.js");

const deepl = require("deepl-node");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const translator = new deepl.Translator(
    process.env.DEEPL_API_KEY,
    {
        serverUrl:
            process.env.DEEPL_PLAN === "free"
                ? "https://api-free.deepl.com"
                : "https://api.deepl.com"
    }
);

const TARGET_LANGUAGE = "EN-GB";

const COOLDOWN_MS = 5_000;
const MAX_LENGTH = 4_000;
const CACHE_TTL = 60 * 60 * 1000;

const cooldowns = new Map();
const translationCache = new Map();
const webhookCache = new Map();

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
});

/**
 * Get or create the translator webhook for a channel.
 */
async function getWebhook(channel) {
    const cached = webhookCache.get(channel.id);

    if (cached) {
        try {
            return await client.fetchWebhook(
                cached.id,
                cached.token
            );
        } catch {
            webhookCache.delete(channel.id);
        }
    }

    const webhooks = await channel.fetchWebhooks();

    let webhook = webhooks.find(
        hook =>
            hook.owner?.id === client.user.id &&
            hook.token
    );

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: "Translator",
            reason: "Public DeepL translations"
        });
    }

    webhookCache.set(channel.id, {
        id: webhook.id,
        token: webhook.token
    });

    return webhook;
}

/**
 * Translate into English.
 * DeepL automatically detects the source language.
 */
async function translate(text) {
    const cacheKey = `${TARGET_LANGUAGE}:${text}`;

    const cached = translationCache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.createdAt < CACHE_TTL
    ) {
        return cached.result;
    }

    const result = await translator.translateText(
        text,
        null,
        TARGET_LANGUAGE
    );

    const value = {
        text: result.text,
        detectedLanguage: result.detectedSourceLang
    };

    translationCache.set(cacheKey, {
        result: value,
        createdAt: Date.now()
    });

    return value;
}

client.on("messageCreate", async message => {
    if (message.author.bot || message.webhookId) return;
    if (!message.guild) return;

    // The ONLY command is `.tr`
    if (message.content.trim().toLowerCase() !== ".tr") {
        return;
    }

    // `.tr` must be used as a reply
    if (!message.reference?.messageId) {
        const warning = await message.reply(
            "Reply to a message using `.tr`."
        );

        setTimeout(() => {
            warning.delete().catch(() => {});
        }, 5_000);

        return;
    }

    // Per-user cooldown
    const lastUse =
        cooldowns.get(message.author.id) || 0;

    const remaining =
        COOLDOWN_MS -
        (Date.now() - lastUse);

    if (remaining > 0) {
        const warning = await message.reply(
            `Please wait ${Math.ceil(
                remaining / 1000
            )} seconds.`
        );

        setTimeout(() => {
            warning.delete().catch(() => {});
        }, 3_000);

        return;
    }

    cooldowns.set(
        message.author.id,
        Date.now()
    );

    try {
        const targetMessage =
            await message.channel.messages.fetch(
                message.reference.messageId
            );

        const text =
            targetMessage.content.trim();

        if (!text) {
            const warning = await message.reply(
                "That message contains no translatable text."
            );

            setTimeout(() => {
                warning.delete().catch(() => {});
            }, 5_000);

            return;
        }

        if (text.length > MAX_LENGTH) {
            const warning = await message.reply(
                `That message exceeds the ${MAX_LENGTH}-character limit.`
            );

            setTimeout(() => {
                warning.delete().catch(() => {});
            }, 5_000);

            return;
        }

        const translated = await translate(text);

        // Already English → do nothing.
        if (
            translated.detectedLanguage
                ?.toUpperCase()
                .startsWith("EN")
        ) {
            await message.delete().catch(() => {});
            return;
        }

        const webhook =
            await getWebhook(message.channel);

        const displayName =
            targetMessage.member?.displayName ||
            targetMessage.author.globalName ||
            targetMessage.author.username;

        // Remove `.tr`
        await message.delete().catch(() => {});

        // Re-send translation through webhook
        await webhook.send({
            username:
                `${displayName} • Translated`,

            avatarURL:
                targetMessage.author.displayAvatarURL({
                    size: 256
                }),

            content:
                `${translated.text}\n` +
                `-# ${translated.detectedLanguage.toUpperCase()} → EN-GB • ${targetMessage.url}`,

            allowedMentions: {
                parse: []
            }
        });

    } catch (error) {
        console.error(
            "Translation error:",
            error
        );

        const warning =
            await message.reply(
                "Translation failed. Check the DeepL key and bot permissions."
            ).catch(() => null);

        if (warning) {
            setTimeout(() => {
                warning.delete().catch(() => {});
            }, 7_000);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
