import { createSocket, hasRegisteredSession } from "./connector/socket/index.ts";
import { getConfig, watchConfig } from "./connector/config.ts";
import { loadCommands } from "./helpers/handling-plugins.ts";
import { startAutoReloader, stopAutoReloader } from "./lib/func/autoReloader.ts";
import { loadMarkers } from "./lib/func/markers.ts"; 
import { loadUsers } from "./lib/usermanager/users.ts"; 
import { log } from "./connector/logger/index-logging.ts";
import {
  promptAdditionalOwners,
  promptConfirm,
  promptLoginMethod,
  promptPhoneNumber,
} from "./connector/logger/prompt.ts";
import {
  addAdditionalOwners,
  loadOwner,
  setPrimaryOwner,
} from "./lib/usermanager/owner.ts";
import { warmGroupMetadata } from "./lib/group-metadata/index.ts";
import { resolve } from "node:path";
import { registerFakeReply } from "./src/setfakereply/index.ts";

function printWelcome(): void {
  const cfg = getConfig();
  log.banner(cfg.bot.name, cfg.bot.footer);
}

async function main(): Promise<void> {
  registerFakeReply();
  printWelcome();
  watchConfig();

  const { total, byCategory } = await loadCommands("./commands");

  log.box("Commands Loaded", [
    ["Total", String(total)],
    ...Object.entries(byCategory).map(
      ([cat, count]) => [cat, String(count)] as [string, string],
    ),
  ]);

  const cfg = getConfig();
  if (cfg.features?.autoReload !== false) startAutoReloader("./commands");
  await loadOwner();
  await loadUsers();
  await loadMarkers(); 

  const sqlitePath = resolve(
    process.cwd(),
    cfg.session.sqlitePath ?? "./db/sqljs/session.db",
  );
  const sessionExists = await hasRegisteredSession(sqlitePath, cfg.session.id);

  let client;

  if (sessionExists) {    
    log.success("Session found, connecting directly without re-pairing.");
    log.box("Session Info", [
      ["Bot", cfg.bot.name],
      ["Session ID", cfg.session.id],
      ["Mode", "Reconnect (session existing)"],
      ["DB", cfg.session.sqlitePath],
      ["Node", process.version],
      ["Platform", `${process.platform}/${process.arch}`],
    ]);

    client = await createSocket({ skipAuthUI: true });
  } else {
    const loginMethod = await promptLoginMethod();
    const usePairing = loginMethod === "pairing";

    let pairingPhone = "";
    if (usePairing) {
      const defaultPhone = (cfg.owner.primary || "").replace(/\D/g, "");
      if (defaultPhone) {
        console.log(`\nDefault number from config: ${defaultPhone}`);
        pairingPhone = (await promptConfirm("Use this number?", true))
          ? defaultPhone
          : await promptPhoneNumber();
      } else {
        pairingPhone = await promptPhoneNumber();
      }
    }

    let additionalOwners: string[] = [];
    if (usePairing) {
      additionalOwners = await promptAdditionalOwners();
    }

    log.box("Session Info", [
      ["Bot", cfg.bot.name],
      ["Session ID", cfg.session.id],
      ["Login", usePairing ? "Pairing Code" : "QR Code"],
      ["Primary", pairingPhone || "(empty)"],
      ["Owner +", additionalOwners.length ? additionalOwners.join(", ") : "(none)"],
      ["DB", cfg.session.sqlitePath],
      ["Node", process.version],
      ["Platform", `${process.platform}/${process.arch}`],
    ]);

    client = await createSocket({ usePairing, pairingPhone });

    client.on("auth_paired", async ({ credentials }) => {
      try {
        const meJid = credentials.meJid;
        if (meJid) {
          const phone = meJid.split("@")[0].replace(/\D/g, "");
          await setPrimaryOwner(phone);
        }
        if (additionalOwners.length > 0) {
          await addAdditionalOwners(additionalOwners);
        }
      } catch (err) {
        log.error(
          `Failed to save owner: ${err instanceof Error ? err.message : err}`,
        );
      }
    });
  }

  log.info("Connecting to WhatsApp...");
  await client.connect();
  warmKnownGroups(client, cfg);

  const shutdown = async (signal: string) => {
    log.warn(`Received ${signal}, shutting down bot...`);
    stopAutoReloader();
    await client.disconnect().catch(() => undefined);
    log.success("Bot stopped.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function warmKnownGroups(client: any, cfg: any): void {
  const jids = new Set<string>();

  if (cfg.group?.id?.endsWith("@g.us")) {
    jids.add(cfg.group.id);
  }

  if (Array.isArray(cfg.warmGroups)) {
    for (const jid of cfg.warmGroups) {
      if (typeof jid === "string" && jid.endsWith("@g.us")) {
        jids.add(jid);
      }
    }
  }

  if (jids.size === 0) return;

  log.info(`Warming cache for ${jids.size} groups...`);

  for (const jid of jids) {
    warmGroupMetadata(client, jid);
  }
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
