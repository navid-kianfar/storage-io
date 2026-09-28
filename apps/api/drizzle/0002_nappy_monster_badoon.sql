CREATE TABLE `metrics_traffic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`at` text NOT NULL,
	`requests` integer NOT NULL,
	`errors` integer NOT NULL,
	`rx_bytes` integer NOT NULL,
	`tx_bytes` integer NOT NULL,
	`requests_per_sec` real,
	`errors_per_sec` real,
	`rx_bytes_per_sec` real,
	`tx_bytes_per_sec` real,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metrics_traffic_server_at_idx` ON `metrics_traffic` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `notification_dedup` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`last_raised_at` text NOT NULL,
	`suppressed` integer DEFAULT 0 NOT NULL
);
