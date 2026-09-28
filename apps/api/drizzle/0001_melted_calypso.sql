CREATE TABLE `bucket_size_daily` (
	`server_id` text NOT NULL,
	`bucket` text NOT NULL,
	`day` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`objects` integer,
	`at` text NOT NULL,
	PRIMARY KEY(`server_id`, `bucket`, `day`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bucket_size_daily_day_idx` ON `bucket_size_daily` (`day`);--> statement-breakpoint
ALTER TABLE `bucket_cache` ADD `last_write_at` text;