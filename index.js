require("dotenv").config();

const { Client, Events, GatewayIntentBits } = require("discord.js");

const deepl = require("deepl-node");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const translator = new deepl.Translator(process.env.DEEPL_API_KEY);

const TARGET_LANGUAGE = "EN-US";

const COOLDOWN_MS = 5_000;
const MAX_LENGTH = 2_000;
const CACHE_TTL = 60 * 60 * 1000;

const cooldowns = new Map();
const translationCache = new Map();
const webhookCache = new Map();

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
});

/**
 * Get or create the translator webhook for a channel.
 */
async function getWebhook(channel) {
    const cached = webhookCache.get(channel.id);

    if (cached) {
        try {
            return await client.fetchWebhook(cached.id, cached.token);
        } catch {
            webhookCache.delete(channel.id);
        }
    }

    const webhooks = await channel.fetchWebhooks();

    let webhook = webhooks.find(
        (hook) => hook.owner?.id === client.user.id && hook.token,
    );

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: "Translator",
            reason: "Public DeepL translations",
        });
    }

    webhookCache.set(channel.id, {
        id: webhook.id,
        token: webhook.token,
    });

    return webhook;
}

/**
 * Translate into English.
 *
 * If sourceLanguage is provided, DeepL uses that language.
 * Otherwise, DeepL automatically detects the source language.
 */
async function translate(text, sourceLanguage = null) {
    const source = sourceLanguage || "AUTO";
    const cacheKey = `${source}:${TARGET_LANGUAGE}:${text}`;

    const cached = translationCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
        return cached.result;
    }

    const result = await translator.translateText(
        text,
        sourceLanguage,
        TARGET_LANGUAGE,
    );

    const value = {
        text: result.text,
        detectedLanguage:
            result.detectedSourceLang || sourceLanguage,
    };

    translationCache.set(cacheKey, {
        result: value,
        createdAt: Date.now(),
    });

    return value;
}

client.on("messageCreate", async (message) => {
    if (message.author.bot || message.webhookId) return;
    if (!message.guild) return;

    const command = message.content.trim();

    /*
     * Supported commands:
     *
     * .tr       → automatically detect source language
     * .tr pl    → manually specify Polish
     * .tr de    → manually specify German
     * .tr PL    → also works
     */
    const parts = command.split(/\s+/);

    if (parts[0].toLowerCase() !== ".tr") {
        return;
    }

    // Only `.tr` or `.tr <language>` are valid.
    if (parts.length > 2) {
        await message.reply(
            "Use `.tr` or `.tr <language code>` to translate a message",
        );
        return;
    }

    // Optional manually specified source language.
    const sourceLanguage =
        parts.length === 2
            ? parts[1].toUpperCase()
            : null;

    // Language code must be exactly two letters.
    if (sourceLanguage && !/^[A-Z]{2}$/.test(sourceLanguage)) {
        await message.reply(
            "Please use a two-letter language code, e.g. `.tr PL`.",
        );
        return;
    }

    // `.tr` / `.tr <lang>` must be used as a reply.
    if (!message.reference?.messageId) {
        await message.reply(
            "Reply to a message using `.tr`.",
        );
        return;
    }

    // Per-user cooldown.
    const lastUse =
        cooldowns.get(message.author.id) || 0;

    const remaining =
        COOLDOWN_MS -
        (Date.now() - lastUse);

    if (remaining > 0) {
        await message.reply(
            `Please wait ${Math.ceil(
                remaining / 1000,
            )} seconds.`,
        );
        return;
    }

    cooldowns.set(
        message.author.id,
        Date.now(),
    );

    try {
        const targetMessage =
            await message.channel.messages.fetch(
                message.reference.messageId,
            );

        const text =
            targetMessage.content.trim();

        if (!text) {
            const warning = await message.reply(
                "That message contains no translatable text.",
            );

            setTimeout(() => {
                warning.delete().catch(() => {});
            }, 5_000);

            return;
        }

        if (text.length > MAX_LENGTH) {
            await message.reply(
                `That message exceeds the ${MAX_LENGTH}-character limit.`,
            );
            return;
        }

        /*
         * If the user explicitly specified English as the source,
         * there is nothing to translate.
         */
        if (
            sourceLanguage &&
            sourceLanguage.startsWith("EN")
        ) {
            await message.delete().catch(() => {});
            return;
        }

        const translated = await translate(
            text,
            sourceLanguage,
        );

        /*
         * With autodetection, don't translate messages that
         * DeepL identified as English.
         */
        if (
            !sourceLanguage &&
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

        // Remove `.tr` command.
        await message.delete().catch(() => {});

        // Re-send translation through webhook.
        await webhook.send({
            username:
                `${displayName} • Translated`,

            avatarURL:
                targetMessage.author.displayAvatarURL({
                    size: 256,
                }),

            content:
                `${translated.text}\n` +
                `-# ${translated.detectedLanguage.toUpperCase()} → ${TARGET_LANGUAGE} • ${targetMessage.url}`,

            allowedMentions: {
                parse: [],
            },
        });
    } catch (error) {
        console.error(
            "Translation error:",
            error,
        );

        const warning =
            await message.reply(
                "Translation failed. Check the language code and try again.",
            ).catch(() => null);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
