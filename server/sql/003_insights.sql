ALTER TABLE users
  MODIFY role ENUM('admin', 'manager', 'user') NOT NULL DEFAULT 'user',
  ADD COLUMN gitlab_username VARCHAR(255) NULL,
  ADD COLUMN git_emails JSON NULL;

CREATE TABLE projects (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  gitlab_url VARCHAR(255) NOT NULL,
  gitlab_project VARCHAR(255) NOT NULL,
  token_enc TEXT NULL,
  last_synced_at DATETIME NULL,
  sync_error VARCHAR(500) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_projects_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE commits (
  project_id INT UNSIGNED NOT NULL,
  sha CHAR(40) NOT NULL,
  author_name VARCHAR(255) NOT NULL,
  author_email VARCHAR(255) NOT NULL,
  authored_at DATETIME NOT NULL,
  additions INT NOT NULL,
  deletions INT NOT NULL,
  PRIMARY KEY (project_id, sha),
  KEY idx_commits_time (project_id, authored_at),
  KEY idx_commits_email (author_email),
  CONSTRAINT fk_commits_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE merge_requests (
  project_id INT UNSIGNED NOT NULL,
  iid INT UNSIGNED NOT NULL,
  title VARCHAR(500) NOT NULL,
  author_username VARCHAR(255) NOT NULL,
  author_name VARCHAR(255) NOT NULL,
  state VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  merged_at DATETIME NULL,
  merged_by VARCHAR(255) NULL,
  reviewers JSON NOT NULL,
  web_url VARCHAR(500) NOT NULL,
  PRIMARY KEY (project_id, iid),
  KEY idx_mr_created (project_id, created_at),
  CONSTRAINT fk_mr_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mr_events (
  project_id INT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  action ENUM('approved', 'commented') NOT NULL,
  author_username VARCHAR(255) NOT NULL,
  target_iid INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (project_id, event_id),
  KEY idx_events_time (project_id, created_at),
  CONSTRAINT fk_events_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
