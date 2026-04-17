CREATE TABLE `foreign_ingest_done` (
	`tool` text NOT NULL,
	`source_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`git_root` text NOT NULL DEFAULT '',
	`done_at` integer NOT NULL,
	PRIMARY KEY (`tool`, `source_path`, `content_hash`)
);
--> statement-breakpoint
CREATE INDEX `foreign_ingest_done_tool_idx` ON `foreign_ingest_done` (`tool`);--> statement-breakpoint
CREATE INDEX `foreign_ingest_done_git_root_idx` ON `foreign_ingest_done` (`git_root`);
