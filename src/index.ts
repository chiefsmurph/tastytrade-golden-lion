import { startIpcServer } from "./ipc-server";
import { startMarketOpenScheduler, stopMarketOpenScheduler, getMarketOpenSchedulerStatus } from "./bot/market-open-scheduler";
import { startSecretSocketConnection } from "./strategy/secret";
import { installQuoteStreamerConsoleGuard } from "./core/quote-streamer-recovery";
import { logStartupConfig } from "./startup-config";
import { cancelAllLiveOrders } from "./bot/execute-position-evaluations";
import { getManagedAccountNumbers } from "./core/default-account";
import { notifyEvent } from "./bot/notify";

logStartupConfig();
installQuoteStreamerConsoleGuard();
startSecretSocketConnection();
startIpcServer();

if (process.env.BOT_RUN_ON_SCHEDULE === "true") {
	console.log("Starting market-open scheduler");
	startMarketOpenScheduler();
}

async function gracefulShutdown(signal: string): Promise<void> {
	console.log(`Received ${signal} — shutting down gracefully`);
	stopMarketOpenScheduler();

	// Wait for any in-flight cycle to finish, up to 30s
	const deadline = Date.now() + 30_000;
	while (getMarketOpenSchedulerStatus().inFlight && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	// Cancel any working orders left by a mid-cycle exit
	try {
		const accounts = await getManagedAccountNumbers();
		await Promise.all(accounts.map((acct) => cancelAllLiveOrders(acct)));
	} catch (err) {
		console.error("cancelAllLiveOrders during shutdown failed:", err);
		notifyEvent(
			"cancel-orders-failed",
			`shutdown (${signal}): cancelAllLiveOrders failed — ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	process.exit(0);
}

process.on("SIGTERM", () => { gracefulShutdown("SIGTERM").catch(console.error); });
process.on("SIGINT",  () => { gracefulShutdown("SIGINT").catch(console.error); });
