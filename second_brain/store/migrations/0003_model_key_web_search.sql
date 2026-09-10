-- Remember which web search model each person's key was granted.
--
-- A column of its own rather than one more entry in `models`, because the two
-- mean different things to the laptop: `models` is what the model picker
-- offers, and its first entry is the model an account opens on, while the web
-- search model is something the agent's search tool calls and nobody can talk
-- to. Folded into one list, nothing would tell them apart once an operator
-- changed which model is the search one.
--
-- '' means no grant. Applied by second_brain/store/engine.py after 0002, under
-- the same lock.

ALTER TABLE model_keys
    ADD COLUMN IF NOT EXISTS web_search_model TEXT NOT NULL DEFAULT '';
