import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

dotenv.config();

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");

async function main() {
    console.log("RC: Conectando...");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log("✅ Conectado. Obteniendo el último chat activo...");

    // Solo traemos 1 dialogo, el más reciente
    const dialogs = await client.getDialogs({ limit: 1 });

    if (dialogs.length > 0) {
        const chat = dialogs[0];
        console.log("\nvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
        console.log(`📛 Nombre del Chat:  ${chat.title}`);
        console.log(`VX ID DEL CHAT:      ${chat.id}`);  // <--- ESTE ES EL QUE NECESITAS
        console.log("^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n");
        console.log("Copia el número de ID (incluyendo el signo menos '-' si lo tiene) y ponlo en tu .env");
    } else {
        console.log("No encontré chats.");
    }
}

main();