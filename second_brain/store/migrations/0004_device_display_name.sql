-- Account labels must survive the machine name supplied by every heartbeat.
ALTER TABLE devices ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN client_name TEXT NOT NULL DEFAULT '';
