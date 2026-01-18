
import { AppConfig } from "../config/index.js";
import { Logger } from "../utils/logger.js";
import { DriveService } from "./drive.service.js";
import { RipService } from "./rip.service.js";
import { EventEmitter } from "events";

/**
 * Service to handle automatic ripping operations (Auto-Rip)
 */
export class AutoRipService extends EventEmitter {
    constructor() {
        super();
        this.isPolling = false;
        this.pollInterval = null;
        this.ripService = new RipService();
        this.processedDiscs = new Map(); // Map<driveNumber, discTitle>
        this.currentOperation = null;
        this.isChecking = false;
    }

    /**
     * Start the auto-rip polling loop
     */
    start() {
        if (this.isPolling) {
            Logger.info("Auto-Rip service is already running");
            return;
        }

        Logger.info("Starting Auto-Rip service...");
        this.isPolling = true;
        this.startPolling();
        this.emit("status", { state: "scanning" });
    }

    /**
     * Stop the auto-rip polling loop
     */
    stop() {
        if (!this.isPolling) {
            return;
        }

        Logger.info("Stopping Auto-Rip service...");
        this.isPolling = false;
        this.stopPolling();
        this.emit("status", { state: "idle" });
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            isPolling: this.isPolling,
            currentOperation: this.currentOperation
        };
    }

    /**
     * Start the polling interval
     */
    startPolling() {
        this.stopPolling(); // Clear existing if any

        const interval = AppConfig.autoRipPollInterval * 1000;
        Logger.info(`Auto-Rip polling started with interval ${interval}ms`);

        this.pollInterval = setInterval(async () => {
            if (this.currentOperation || this.isChecking) {
                // Skip polling if an operation or check is in progress
                return;
            }

            try {
                this.isChecking = true;
                await this.checkDrives();
            } catch (error) {
                Logger.error("Error during Auto-Rip poll", error);
            } finally {
                this.isChecking = false;
            }
        }, interval);
    }

    /**
     * Stop the polling interval
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Check drives for new discs
     */
    async checkDrives() {
        try {
            // Fast detection (no file info scanning yet)
            // Dynamic import to avoid potential circular dependency issues during init
            const { DiscService } = await import("./disc.service.js");
            const detectedDiscs = await DiscService.detectAvailableDiscs();
            const detectedDriveMap = new Map();

            // Identify currently present discs
            detectedDiscs.forEach(disc => {
                detectedDriveMap.set(disc.driveNumber, disc.title);
            });

            // Cleanup processed list: Remove drives that are empty or have different titles
            for (const [driveNumber, title] of this.processedDiscs.entries()) {
                if (!detectedDriveMap.has(driveNumber) || detectedDriveMap.get(driveNumber) !== title) {
                    this.processedDiscs.delete(driveNumber);
                }
            }

            // Filter for new discs
            const newDiscs = detectedDiscs.filter(disc =>
                !this.processedDiscs.has(disc.driveNumber)
            );

            if (newDiscs.length > 0) {
                Logger.info(`Auto-Rip detected ${newDiscs.length} new disc(s). Getting full info...`);

                // Get complete info (file numbers) only for new discs
                const completeDiscItems = await DiscService.getCompleteDiscInfo(newDiscs);

                Logger.info(`Starting processing for ${completeDiscItems.length} valid disc(s)...`);
                await this.processDiscs(completeDiscItems);
            }
        } catch (error) {
            // Ignore "MakeMKV executable not found" during polling to avoid log spam if it's transient
            // or if MakeMKV is busy
            if (error.message && !error.message.includes("executable not found")) {
                Logger.warning(`Auto-Rip polling warning: ${error.message}`);
            }
        }
    }

    /**
     * Process detected discs
     * @param {Array} commandDataItems - List of discs to process
     */
    async processDiscs(commandDataItems) {
        if (!commandDataItems || commandDataItems.length === 0) return;

        this.currentOperation = "processing";
        this.emit("status", { state: "processing" });

        try {
            const mode = AppConfig.autoRipMode; // "rip" or "backup"

            // Mark discs as processed BEFORE processing to prevent double-triggering
            commandDataItems.forEach(item => {
                this.processedDiscs.set(item.driveNumber, item.title);
            });

            if (mode === "backup") {
                await this.ripService.processBackupQueue(commandDataItems);
            } else {
                await this.ripService.processRippingQueue(commandDataItems);
            }

        } catch (error) {
            Logger.error("Auto-Rip processing failed", error);
        } finally {
            this.currentOperation = null;
            this.emit("status", { state: "scanning" });
        }
    }
}

// Singleton instance
export const autoRipService = new AutoRipService();
