CREATE TABLE `board` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text DEFAULT 'flappyboard' NOT NULL,
	`sound_pack` text DEFAULT 'classic' NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `board_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`revision` integer NOT NULL,
	`cells` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`prompt` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `board`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_snapshot_board_revision_unq` ON `board_snapshot` (`board_id`,`revision`);