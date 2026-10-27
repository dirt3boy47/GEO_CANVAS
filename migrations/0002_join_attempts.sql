-- Wrong join codes per IP address and 10-minute window; 20 wrong tries lock that address out until the window ends.
CREATE TABLE IF NOT EXISTS fails (
  ip TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (ip, win)
);
