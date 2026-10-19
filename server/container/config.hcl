storage "postgresql" {
  connection_url      = "env://BAO_PG_CONNECTION_URL"
  ha_enabled          = "false"
  max_connect_retries = "10"
}

seal "static" {
  current_key_id = "seal-1"
  current_key    = "env://BAO_SEAL_KEY"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

disable_mlock = true
ui            = true

# OpenBao 2.7 refuses `bao audit enable` over the API; audit devices are declarative.
audit "file" "stdout" {
  description = "audit log to container stdout"
  options {
    file_path = "stdout"
  }
}
