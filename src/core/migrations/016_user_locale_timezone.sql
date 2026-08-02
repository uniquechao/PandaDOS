-- Account locale is initialized by the browser after the first authenticated load.
-- timezone NULL means automatic; detected_timezone is the latest valid browser zone
-- used by server-side notifications while automatic mode is active.
ALTER TABLE user_settings ADD COLUMN locale TEXT;
ALTER TABLE user_settings ADD COLUMN timezone TEXT;
ALTER TABLE user_settings ADD COLUMN detected_timezone TEXT;
