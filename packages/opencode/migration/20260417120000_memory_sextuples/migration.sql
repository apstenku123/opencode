CREATE TABLE `memory_sextuple` (
	`id` text PRIMARY KEY,
	`hash_id` text NOT NULL,
	`project_id` text,
	`keywords` text NOT NULL,
	`problem` text NOT NULL,
	`root_cause` text NOT NULL,
	`solution` text NOT NULL,
	`source` text NOT NULL,
	`embedding` blob,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_sextuple_hash_id_idx` ON `memory_sextuple` (`hash_id`);--> statement-breakpoint
CREATE INDEX `memory_sextuple_project_id_idx` ON `memory_sextuple` (`project_id`);--> statement-breakpoint
CREATE INDEX `memory_sextuple_time_created_idx` ON `memory_sextuple` (`time_created`);
