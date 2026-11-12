-- Skills are on for every Bot by default (S2): bot_skill_blocks (0041) lists
-- the exceptions, so the per-Bot opt-in rows are no longer read. Every
-- existing Skill becomes available to all of its owner's Bots.
DROP TABLE "bot_skills" CASCADE;
