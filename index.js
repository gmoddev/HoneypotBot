const {
    Client,
    GatewayIntentBits,
    Events,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    REST,
    Routes
} = require("discord.js");

const Database = require("better-sqlite3");
const Path = require("path");
const Fs = require("fs");

// ================= CONFIG =================

const Config = {
    Token: process.env.DISCORD_TOKEN,
    ClientId: process.env.CLIENT_ID,

    DatabaseFolder: Path.join(__dirname, "data"),
    DatabaseFile: "honeypot.db",

    DefaultChannelName: "honeypot",
    DefaultEnabled: 0,

    DefaultBanReason: "Honeypot Triggered",
    DefaultBanLength: "0",
    DefaultDeleteMessageSeconds: 604800,

    DefaultEmbedTitle: "Honeypot Channel",
    DefaultEmbedDescription:
        "If you talk in here, you will be **banned automatically**.\nAppeals will **not** be given.",
    DefaultEmbedColor: 0xff0000,
    DefaultEmbedFooter: "This is an automated moderation channel",

    StartupEnsureChannels: true,
    ExpirationCheckIntervalMs: 30000
};

// ================= TIME HELPERS =================

function ParsePunishmentLength(Input) {
    if (!Input) return null;

    const Value = Input.toLowerCase().trim();

    if (Value === "kick") {
        return {
            action: "kick",
            durationMs: 0,
            normalized: "kick"
        };
    }

    if (Value === "0") {
        return {
            action: "ban",
            durationMs: 0,
            normalized: "0"
        };
    }

    const Match = Value.match(/^(\d+)([smhdwy])$/);
    if (!Match) return null;

    const Amount = Number(Match[1]);
    const Unit = Match[2];

    const Multipliers = {
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000,
        w: 604800000,
        y: 31536000000
    };

    return {
        action: "ban",
        durationMs: Amount * Multipliers[Unit],
        normalized: `${Amount}${Unit}`
    };
}

function FormatPunishmentLength(Value) {
    if (Value === "0") return "Permanent";
    if (Value === "kick") return "Kick";
    return Value;
}

// ================= DATABASE =================

if (!Fs.existsSync(Config.DatabaseFolder)) {
    Fs.mkdirSync(Config.DatabaseFolder, { recursive: true });
}

const Db = new Database(
    Path.join(Config.DatabaseFolder, Config.DatabaseFile)
);

Db.prepare(`
CREATE TABLE IF NOT EXISTS honeypot (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    channel_name TEXT NOT NULL DEFAULT 'honeypot',
    ban_reason TEXT NOT NULL DEFAULT 'Honeypot Triggered',
    ban_length TEXT NOT NULL DEFAULT '0',
    delete_message_seconds INTEGER NOT NULL DEFAULT 604800,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`).run();

Db.prepare(`
CREATE TABLE IF NOT EXISTS honeypot_temp_bans (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
`).run();

const GetHoneypot = Db.prepare(
    `SELECT * FROM honeypot WHERE guild_id = ?`
);

const InsertGuildConfig = Db.prepare(`
INSERT INTO honeypot (
    guild_id,
    channel_id,
    enabled,
    channel_name,
    ban_reason,
    ban_length,
    delete_message_seconds,
    created_at,
    updated_at
)
VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
`);

const InsertTempBan = Db.prepare(`
INSERT INTO honeypot_temp_bans (
    guild_id,
    user_id,
    expires_at,
    reason,
    created_at
)
VALUES (
    @guild_id,
    @user_id,
    @expires_at,
    @reason,
    @created_at
)
ON CONFLICT(guild_id, user_id)
DO UPDATE SET
    expires_at = excluded.expires_at
`);

const RemoveTempBan = Db.prepare(`
DELETE FROM honeypot_temp_bans
WHERE guild_id = ? AND user_id = ?
`);

const GetExpiredTempBans = Db.prepare(`
SELECT * FROM honeypot_temp_bans
WHERE expires_at <= ?
`);

function EnsureGuildConfig(Guild) {
    let Record = GetHoneypot.get(Guild.id);
    if (Record) return Record;

    const Now = Date.now();

    InsertGuildConfig.run(
        Guild.id,
        Config.DefaultEnabled,
        Config.DefaultChannelName,
        Config.DefaultBanReason,
        Config.DefaultBanLength,
        Config.DefaultDeleteMessageSeconds,
        Now,
        Now
    );

    return GetHoneypot.get(Guild.id);
}

function UpdateGuildConfig(GuildId, Updates) {
    const Entries = Object.entries(Updates).filter(
        ([, Value]) => Value !== undefined
    );

    if (!Entries.length) {
        return GetHoneypot.get(GuildId);
    }

    const Sets = Entries.map(([Key]) => `${Key} = ?`);
    const Values = Entries.map(([, Value]) => Value);

    Values.push(Date.now(), GuildId);

    Db.prepare(`
        UPDATE honeypot
        SET ${Sets.join(", ")}, updated_at = ?
        WHERE guild_id = ?
    `).run(...Values);

    return GetHoneypot.get(GuildId);
}

// ================= CHANNEL =================

async function EnsureHoneypotChannel(Guild) {
    const Record = EnsureGuildConfig(Guild);

    let Channel = Record.channel_id
        ? Guild.channels.cache.get(Record.channel_id)
        : null;

    if (!Channel) {
        Channel = await Guild.channels.create({
            name: Record.channel_name,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                {
                    id: Guild.roles.everyone.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                }
            ]
        });
    }

    const Embed = new EmbedBuilder()
        .setTitle(Config.DefaultEmbedTitle)
        .setDescription(Config.DefaultEmbedDescription)
        .setColor(Config.DefaultEmbedColor)
        .setFooter({
            text: Config.DefaultEmbedFooter
        })
        .setTimestamp();

    const Messages = await Channel.messages.fetch({
        limit: 10
    }).catch(() => []);

    const Exists = [...Messages.values()].some(
        m =>
            m.author.id === Guild.client.user.id &&
            m.embeds.length
    );

    if (!Exists) {
        await Channel.send({
            embeds: [Embed]
        });
    }

    UpdateGuildConfig(Guild.id, {
        channel_id: Channel.id
    });

    return Channel;
}

function CanSendInChannel(Channel, Member) {
    if (
        !Channel ||
        !Member ||
        ![
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
        ].includes(Channel.type)
    ) {
        return false;
    }

    const Permissions = Channel.permissionsFor(Member);

    return Boolean(
        Permissions &&
            Permissions.has(PermissionFlagsBits.ViewChannel) &&
            Permissions.has(PermissionFlagsBits.SendMessages)
    );
}

async function FindNoticeChannel(Guild) {
    const Me = Guild.members.me ||
        await Guild.members.fetchMe().catch(() => null);

    if (!Me) return null;

    await Guild.channels.fetch().catch(() => null);

    if (CanSendInChannel(Guild.systemChannel, Me)) {
        return Guild.systemChannel;
    }

    return Guild.channels.cache
        .filter(Channel => CanSendInChannel(Channel, Me))
        .sort((A, B) => A.rawPosition - B.rawPosition)
        .first() || null;
}

async function SendJoinNotice(Guild) {
    EnsureGuildConfig(Guild);

    const Channel = await FindNoticeChannel(Guild);
    if (!Channel) {
        console.warn(
            `[Honeypot] No sendable channel found in ${Guild.name}`
        );
        return;
    }

    const Owner = await Guild.fetchOwner().catch(() => null);
    const OwnerMention = Owner
        ? `<@${Owner.id}> `
        : Guild.ownerId
            ? `<@${Guild.ownerId}> `
            : "";

    await Channel.send({
        content:
            `${OwnerMention}Thanks for adding Honeypot Bot.\n` +
            "Make sure to enable protection with `/honeypot enable` " +
            `so I can create and monitor the honeypot channel.`,
        allowedMentions: Owner
            ? { users: [Owner.id] }
            : Guild.ownerId
                ? { users: [Guild.ownerId] }
                : { parse: [] }
    });
}

// ================= CLIENT =================

const ClientBot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildBans
    ]
});

// ================= COMMANDS =================

const Commands = [
    new SlashCommandBuilder()
        .setName("honeypot")
        .setDescription("Manage honeypot protection.")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.Administrator
        )

        .addSubcommand(Sub =>
            Sub.setName("enable")
                .setDescription("Enable honeypot.")
        )

        .addSubcommand(Sub =>
            Sub.setName("disable")
                .setDescription("Disable honeypot.")
        )

        .addSubcommand(Sub =>
            Sub.setName("view")
                .setDescription("View honeypot status.")
        )

        .addSubcommand(Sub =>
            Sub.setName("config")
                .setDescription("Configure honeypot.")
                .addStringOption(Option =>
                    Option.setName("ban_length")
                        .setDescription("kick, 1d, 2d, 1y, 0")
                )
                .addStringOption(Option =>
                    Option.setName("ban_reason")
                        .setDescription("Ban reason")
                )
        )
].map(Command => Command.toJSON());

// ================= READY =================

ClientBot.once(Events.ClientReady, async Client => {
    console.log(`Logged in as ${Client.user.tag}`);

    const RestClient = new REST({
        version: "10"
    }).setToken(Config.Token);

    await RestClient.put(
        Routes.applicationCommands(Config.ClientId),
        { body: Commands }
    );

    console.log("Slash commands registered.");

    await Client.guilds.fetch();

    for (const Guild of Client.guilds.cache.values()) {
        const Record = EnsureGuildConfig(Guild);

        if (
            Config.StartupEnsureChannels &&
            Record.enabled === 1
        ) {
            await EnsureHoneypotChannel(Guild);
        }
    }

    setInterval(async () => {
        const Expired = GetExpiredTempBans.all(Date.now());

        for (const Ban of Expired) {
            const Guild = Client.guilds.cache.get(
                Ban.guild_id
            );

            if (!Guild) continue;

            try {
                await Guild.members.unban(
                    Ban.user_id,
                    "Temporary honeypot ban expired"
                );
            } catch {}

            RemoveTempBan.run(
                Ban.guild_id,
                Ban.user_id
            );
        }
    }, Config.ExpirationCheckIntervalMs);
});

// ================= GUILD JOIN =================

ClientBot.on(
    Events.GuildCreate,
    async Guild => {
        try {
            await SendJoinNotice(Guild);
        } catch (Error) {
            console.error(Error);
        }
    }
);

// ================= MESSAGE EVENT =================

ClientBot.on(
    Events.MessageCreate,
    async Message => {
        if (!Message.guild || Message.author.bot) {
            return;
        }

        const Record = EnsureGuildConfig(
            Message.guild
        );

        if (Record.enabled !== 1) return;
        if (Message.channel.id !== Record.channel_id) {
            return;
        }

        try {
            const Punishment =
                ParsePunishmentLength(
                    Record.ban_length
                );

            if (!Punishment) return;

            if (Punishment.action === "kick") {
                await Message.member.kick(
                    Record.ban_reason
                );

                console.log(
                    `[Honeypot] Kicked ${Message.author.tag}`
                );

                return;
            }

            const CreatedAt = Date.now();
            const ExpiresAt =
                Punishment.durationMs === 0
                    ? 0
                    : CreatedAt +
                      Punishment.durationMs;

            await Message.member.ban({
                reason: Record.ban_reason,
                deleteMessageSeconds:
                    Record.delete_message_seconds
            });

            if (ExpiresAt !== 0) {
                InsertTempBan.run({
                    guild_id: Message.guild.id,
                    user_id: Message.author.id,
                    expires_at: ExpiresAt,
                    reason: Record.ban_reason,
                    created_at: CreatedAt
                });
            }

            console.log(
                `[Honeypot] Banned ${Message.author.tag}`
            );
        } catch (Error) {
            console.error(Error);
        }
    }
);

// ================= INTERACTIONS =================

ClientBot.on(
    Events.InteractionCreate,
    async Interaction => {
        if (!Interaction.isChatInputCommand()) {
            return;
        }

        if (Interaction.commandName !== "honeypot") {
            return;
        }

        const Subcommand =
            Interaction.options.getSubcommand();

        let Record = EnsureGuildConfig(
            Interaction.guild
        );

        if (Subcommand === "enable") {
            const Channel =
                await EnsureHoneypotChannel(
                    Interaction.guild
                );

            Record = UpdateGuildConfig(
                Interaction.guild.id,
                {
                    enabled: 1,
                    channel_id: Channel.id
                }
            );

            return Interaction.reply({
                content:
                    `Honeypot enabled.\n` +
                    `Channel: <#${Channel.id}>`,
                ephemeral: true
            });
        }

        if (Subcommand === "disable") {
            Record = UpdateGuildConfig(
                Interaction.guild.id,
                {
                    enabled: 0
                }
            );

            return Interaction.reply({
                content: "Honeypot disabled.",
                ephemeral: true
            });
        }

        if (Subcommand === "view") {
            return Interaction.reply({
                content:
                    `Enabled: ${
                        Record.enabled === 1
                    }\n` +
                    `Channel: ${
                        Record.channel_id
                            ? `<#${Record.channel_id}>`
                            : "None"
                    }\n` +
                    `Ban Length: ${FormatPunishmentLength(
                        Record.ban_length
                    )}`,
                ephemeral: true
            });
        }

        if (Subcommand === "config") {
            const BanLength =
                Interaction.options.getString(
                    "ban_length"
                );

            const BanReason =
                Interaction.options.getString(
                    "ban_reason"
                );

            if (BanLength) {
                const Parsed =
                    ParsePunishmentLength(
                        BanLength
                    );

                if (!Parsed) {
                    return Interaction.reply({
                        content:
                            "Invalid ban length.",
                        ephemeral: true
                    });
                }

                Record = UpdateGuildConfig(
                    Interaction.guild.id,
                    {
                        ban_length:
                            Parsed.normalized
                    }
                );
            }

            if (BanReason) {
                Record = UpdateGuildConfig(
                    Interaction.guild.id,
                    {
                        ban_reason: BanReason
                    }
                );
            }

            return Interaction.reply({
                content:
                    "Honeypot config updated.",
                ephemeral: true
            });
        }
    }
);

// ================= LOGIN =================

ClientBot.login(Config.Token);
