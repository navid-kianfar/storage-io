CREATE TABLE `iam_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `iam_entities_lookup_uq` ON `iam_entities` (`server_id`,`kind`,`name`);--> statement-breakpoint
CREATE INDEX `iam_entities_kind_idx` ON `iam_entities` (`kind`);--> statement-breakpoint
CREATE TABLE `__new_bucket_cache` (
	`id` text NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`region` text,
	`created_at` text,
	`objects` integer,
	`size_bytes` integer,
	`stats_at` text,
	`versioning` text DEFAULT 'off' NOT NULL,
	`object_lock` integer DEFAULT false NOT NULL,
	`access` text DEFAULT 'private' NOT NULL,
	`owner` text,
	`tags` text DEFAULT '{}' NOT NULL,
	`default_storage_class` text,
	`noncurrent_versions` integer,
	`last_write_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`server_id`, `name`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_bucket_cache` (`id`, `server_id`, `name`, `region`, `created_at`, `objects`, `size_bytes`, `stats_at`, `versioning`, `object_lock`, `access`, `owner`, `tags`, `default_storage_class`, `noncurrent_versions`, `last_write_at`, `updated_at`) SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), `server_id`, `name`, `region`, `created_at`, `objects`, `size_bytes`, `stats_at`, `versioning`, `object_lock`, `access`, `owner`, `tags`, `default_storage_class`, `noncurrent_versions`, `last_write_at`, `updated_at` FROM `bucket_cache`;--> statement-breakpoint
DROP TABLE `bucket_cache`;--> statement-breakpoint
ALTER TABLE `__new_bucket_cache` RENAME TO `bucket_cache`;--> statement-breakpoint
CREATE UNIQUE INDEX `bucket_cache_id_uq` ON `bucket_cache` (`id`);--> statement-breakpoint
CREATE INDEX `bucket_cache_size_idx` ON `bucket_cache` (`size_bytes`);
