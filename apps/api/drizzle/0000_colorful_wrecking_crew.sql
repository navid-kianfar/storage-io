CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_name` text NOT NULL,
	`target` text,
	`server_id` text,
	`server_name` text,
	`ip` text,
	`result` text NOT NULL,
	`request_id` text,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_at_idx` ON `activity` (`at`);--> statement-breakpoint
CREATE INDEX `activity_category_idx` ON `activity` (`category`);--> statement-breakpoint
CREATE INDEX `activity_server_idx` ON `activity` (`server_id`);--> statement-breakpoint
CREATE INDEX `activity_result_idx` ON `activity` (`result`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_uq` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `bucket_cache` (
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
	`updated_at` text NOT NULL,
	PRIMARY KEY(`server_id`, `name`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bucket_cache_size_idx` ON `bucket_cache` (`size_bytes`);--> statement-breakpoint
CREATE TABLE `health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `health_events_server_at_idx` ON `health_events` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`at` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`key` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_idx` ON `job_logs` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`source_server_id` text NOT NULL,
	`source_bucket` text NOT NULL,
	`filters` text NOT NULL,
	`target_server_id` text,
	`target_bucket` text,
	`target_prefix` text,
	`params` text DEFAULT '{}' NOT NULL,
	`options` text NOT NULL,
	`schedule` text NOT NULL,
	`progress` text NOT NULL,
	`checkpoint` text,
	`next_run_at` text,
	`waiting_for` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_parent_idx` ON `jobs` (`parent_id`);--> statement-breakpoint
CREATE INDEX `jobs_next_run_idx` ON `jobs` (`next_run_at`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `key_meta` (
	`server_id` text NOT NULL,
	`access_key_id` text NOT NULL,
	`user_name` text NOT NULL,
	`name` text,
	`created_at` text,
	`expires_at` text,
	`last_used_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`rotation_replaced_by` text,
	`rotation_disable_at` text,
	`expiry_notified_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`server_id`, `access_key_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `key_meta_expires_at_idx` ON `key_meta` (`expires_at`);--> statement-breakpoint
CREATE INDEX `key_meta_rotation_idx` ON `key_meta` (`rotation_disable_at`);--> statement-breakpoint
CREATE TABLE `metrics_capacity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`at` text NOT NULL,
	`used_bytes` integer NOT NULL,
	`total_bytes` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metrics_capacity_server_at_idx` ON `metrics_capacity` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `metrics_latency` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`at` text NOT NULL,
	`ms` integer NOT NULL,
	`reachable` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metrics_latency_server_at_idx` ON `metrics_latency` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`href` text,
	`read` integer DEFAULT false NOT NULL,
	`rule_key` text
);
--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications` (`read`,`at`);--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`policy_name` text NOT NULL,
	`document` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policy_versions_lookup_idx` ON `policy_versions` (`server_id`,`policy_name`,`created_at`);--> statement-breakpoint
CREATE TABLE `quotas` (
	`server_id` text NOT NULL,
	`bucket` text NOT NULL,
	`limit_bytes` integer NOT NULL,
	`mode` text NOT NULL,
	`threshold_permille` integer DEFAULT 800 NOT NULL,
	`native` integer DEFAULT false NOT NULL,
	`alerted_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`server_id`, `bucket`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `server_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`check_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`duration_ms` integer NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `server_checks_server_at_idx` ON `server_checks` (`server_id`,`at`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`region` text NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`admin_token_encrypted` text,
	`path_style` integer DEFAULT true NOT NULL,
	`tls_verify` integer DEFAULT true NOT NULL,
	`ca_pem` text,
	`admin_endpoint` text,
	`iam_endpoint` text,
	`health_interval_sec` integer DEFAULT 30 NOT NULL,
	`maintenance` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`status_detail` text,
	`latency_ms` integer,
	`last_checked_at` text,
	`last_seen_at` text,
	`version` text,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`capacity_used_bytes` integer,
	`capacity_total_bytes` integer,
	`capacity_budget` integer DEFAULT false NOT NULL,
	`bucket_count` integer DEFAULT 0 NOT NULL,
	`user_count` integer,
	`object_count` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_uq` ON `servers` (`name`);--> statement-breakpoint
CREATE INDEX `servers_status_idx` ON `servers` (`status`);--> statement-breakpoint
CREATE INDEX `servers_provider_idx` ON `servers` (`provider`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`ip` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`section` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
