import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { BotConfig } from "../config/index.ts";
import { ConfigError, loadConfig } from "../config/index.ts";

/** Registers commands only in the configured testing guild. Safe to run on every deployment. */
export async function registerGuildCommands(config: BotConfig): Promise<void> {
  const command = new SlashCommandBuilder()
    .setName("forge")
    .setDescription("BW Forge conversational analyst")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Start a persistent BW Forge conversation")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Optional thread name")
            .setMaxLength(100),
        ),
    );
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.post(
    Routes.applicationGuildCommands(
      config.discord.applicationId,
      config.discord.guildId,
    ),
    { body: command.toJSON() },
  );
}

if (import.meta.main) {
  Promise.resolve()
    .then(() => registerGuildCommands(loadConfig()))
    .catch((error) => {
      console.error(
        error instanceof ConfigError
          ? error.message
          : "Discord command registration failed; check the token, application ID, guild ID, and installation permissions.",
      );
      process.exitCode = 1;
    });
}
