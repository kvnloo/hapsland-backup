import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseToml } from "smol-toml"
const quote = (value) => "'" + value.split("'").join("'\\''") + "'"
const progress = (stage) => process.stderr.write("[native-codex-trust] " + stage + "\n")

class TerminalScreen {
  constructor(rows, columns) {
    this.rows = rows
    this.columns = columns
    this.cells = Array.from({ length: rows }, () => Array(columns).fill(" "))
    this.row = 0
    this.column = 0
    this.saved = [0, 0]
    this.pending = ""
  }

  text() {
    return this.cells.map((row) => row.join("").trimEnd()).join("\n")
  }

  feed(chunk) {
    const input = this.pending + chunk
    this.pending = ""
    let offset = 0
    while (offset < input.length) {
      const character = input[offset]
      if (character === "\u001b") {
        if (offset + 1 >= input.length) {
          this.pending = input.slice(offset)
          break
        }
        const kind = input[offset + 1]
        if (kind === "[") {
          let end = offset + 2
          while (end < input.length && !/[@-~]/.test(input[end])) end += 1
          if (end === input.length) {
            this.pending = input.slice(offset)
            break
          }
          this.#csi(input.slice(offset + 2, end), input[end])
          offset = end + 1
          continue
        }
        if (kind === "]") {
          let end = offset + 2
          while (end < input.length && input[end] !== "\u0007" && !(input[end] === "\u001b" && input[end + 1] === "\\"))
            end += 1
          if (end === input.length) {
            this.pending = input.slice(offset)
            break
          }
          offset = input[end] === "\u0007" ? end + 1 : end + 2
          continue
        }
        if (kind === "7") this.saved = [this.row, this.column]
        else if (kind === "8") [this.row, this.column] = this.saved
        else if (kind === "D") this.#lineFeed()
        else if (kind === "E") {
          this.column = 0
          this.#lineFeed()
        }
        offset += 2
        continue
      }
      if (character === "\r") this.column = 0
      else if (character === "\n") this.#lineFeed()
      else if (character === "\b") this.column = Math.max(0, this.column - 1)
      else if (character === "\t") this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8)
      else if (character >= " " && character !== "\u007f") this.#write(character)
      offset += 1
    }
  }

  #blankRow() {
    return Array(this.columns).fill(" ")
  }

  #lineFeed() {
    if (this.row === this.rows - 1) {
      this.cells.shift()
      this.cells.push(this.#blankRow())
    } else this.row += 1
  }

  #write(character) {
    this.cells[this.row][this.column] = character
    if (this.column === this.columns - 1) {
      this.column = 0
      this.#lineFeed()
    } else this.column += 1
  }

  #csi(rawParameters, final) {
    const parameters = rawParameters
      .replace(/^[?!>]/, "")
      .split(";")
      .map((value) => (value === "" ? 0 : Number(value)))
    const first = parameters[0] || 1
    if (final === "H" || final === "f") {
      this.row = Math.max(0, Math.min(this.rows - 1, (parameters[0] || 1) - 1))
      this.column = Math.max(0, Math.min(this.columns - 1, (parameters[1] || 1) - 1))
    } else if (final === "A") this.row = Math.max(0, this.row - first)
    else if (final === "B") this.row = Math.min(this.rows - 1, this.row + first)
    else if (final === "C") this.column = Math.min(this.columns - 1, this.column + first)
    else if (final === "D") this.column = Math.max(0, this.column - first)
    else if (final === "E") {
      this.row = Math.min(this.rows - 1, this.row + first)
      this.column = 0
    } else if (final === "F") {
      this.row = Math.max(0, this.row - first)
      this.column = 0
    } else if (final === "G") this.column = Math.max(0, Math.min(this.columns - 1, first - 1))
    else if (final === "d") this.row = Math.max(0, Math.min(this.rows - 1, first - 1))
    else if (final === "J") this.#eraseDisplay(parameters[0] || 0)
    else if (final === "K") this.#eraseLine(parameters[0] || 0)
    else if (final === "X") this.cells[this.row].fill(" ", this.column, Math.min(this.columns, this.column + first))
    else if (final === "S") {
      for (let count = 0; count < first; count += 1) {
        this.cells.shift()
        this.cells.push(this.#blankRow())
      }
    } else if (final === "T") {
      for (let count = 0; count < first; count += 1) {
        this.cells.pop()
        this.cells.unshift(this.#blankRow())
      }
    } else if (final === "s") this.saved = [this.row, this.column]
    else if (final === "u") [this.row, this.column] = this.saved
  }

  #eraseDisplay(mode) {
    if (mode === 2 || mode === 3) this.cells = Array.from({ length: this.rows }, () => this.#blankRow())
    else if (mode === 0) {
      this.cells[this.row].fill(" ", this.column)
      for (let row = this.row + 1; row < this.rows; row += 1) this.cells[row].fill(" ")
    } else if (mode === 1) {
      for (let row = 0; row < this.row; row += 1) this.cells[row].fill(" ")
      this.cells[this.row].fill(" ", 0, this.column + 1)
    }
  }

  #eraseLine(mode) {
    if (mode === 0) this.cells[this.row].fill(" ", this.column)
    else if (mode === 1) this.cells[this.row].fill(" ", 0, this.column + 1)
    else if (mode === 2) this.cells[this.row].fill(" ")
  }
}

const establishNativeTrust = (
  codexHome,
  repository,
  env,
  {
    terminal = process.stdin,
    output = process.stderr,
    spawnProcess = spawn,
    signalProcess = process.kill,
    readConfiguration = () => readFile(join(codexHome, "config.toml"), "utf8"),
    timeoutMs = 30_000,
    killGraceMs = 500
  } = {}
) =>
  new Promise((resolveTrust, rejectTrust) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
      rejectTrust(new Error("Native Codex trust requires finite positive time budgets"))
      return
    }
    if (!terminal.isTTY) {
      rejectTrust(new Error("native Codex trust review requires a terminal; rerun real-host conformance from a TTY"))
      return
    }
    const command = `stty rows 24 cols 80; exec ${quote("codex")} --no-alt-screen -C ${quote(repository)}`
    const scriptArguments =
      process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", command] : ["-qefc", command, "/dev/null"]
    const grouped = process.platform !== "win32"
    const child = spawnProcess("script", scriptArguments, {
      cwd: repository,
      env: { ...env, CODEX_HOME: codexHome, TERM: "xterm-256color" },
      detached: grouped,
      stdio: [terminal, "pipe", "pipe"]
    })
    let failure
    let closed = false
    let escalation
    const signal = (value) => {
      try {
        if (grouped) signalProcess(-child.pid, value)
        else child.kill(value)
      } catch (cause) {
        if (cause.code !== "ESRCH") failure ??= cause
      }
    }
    const stop = (cause) => {
      if (closed) return
      failure ??= cause
      signal("SIGTERM")
      escalation ??= setTimeout(() => signal("SIGKILL"), killGraceMs)
    }
    const interrupted = () => stop(new Error("Native Codex trust review interrupted"))
    process.once("SIGINT", interrupted)
    process.once("SIGTERM", interrupted)
    const screen = new TerminalScreen(24, 80)
    let repositorySelected = false
    let hookSelected = false
    let hookChoiceSelected = false
    let repositoryPersisted = false
    let hookPersisted = false
    let trusted = false
    let terminalInitialized = false
    let terminalProbe = ""
    const trustPoll = setInterval(() => {
      void readConfiguration()
        .then((config) => {
          if (closed) return
          const parsed = parseToml(config)
          repositoryPersisted = parsed.projects?.[repository]?.trust_level === "trusted"
          hookPersisted = /^sha256:[0-9a-f]{64}$/.test(
            parsed.hooks?.state?.[join(codexHome, "hooks.json") + ":post_tool_use:0:0"]?.trusted_hash ?? ""
          )
          if (trusted || !repositoryPersisted || !hookPersisted) return
          trusted = true
          progress("native-trust-persisted-awaiting-terminal-close")
          stop()
        })
        .catch(() => undefined)
    }, 100)
    const timer = setTimeout(() => {
      stop(
        new Error(
          `Codex native repository/hook trust review timed out (repository-prompt=${repositorySelected}; repository-persisted=${repositoryPersisted}; hook-prompt=${hookSelected}; trust-choice=${hookChoiceSelected}; hook-persisted=${hookPersisted})`
        )
      )
    }, timeoutMs)
    const observe = (chunk) => {
      output.write(chunk)
      screen.feed(chunk)
      terminalProbe = `${terminalProbe}${chunk}`.slice(-32)
      if (!terminalInitialized && terminalProbe.includes("\u001b[6n")) {
        terminalInitialized = true
        progress("codex-terminal-query-response-needed")
      }
      const rendered = screen.text()
      if (
        !repositorySelected &&
        (rendered.includes("Do you trust the contents of this directory") || rendered.includes("Trust this folder?"))
      ) {
        repositorySelected = true
        progress("native-repository-trust-ready")
      }
      if (!hookSelected && rendered.includes("Hooks need review")) {
        hookSelected = true
        progress("native-hook-trust-review-ready")
      }
      if (hookSelected && !hookChoiceSelected && rendered.includes("› 2. Trust all and continue")) {
        hookChoiceSelected = true
        progress("native-hook-trust-all-confirmation-ready")
      }
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", observe)
    child.stderr.on("data", (chunk) => output.write(chunk))
    const cleanup = () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(escalation)
      clearInterval(trustPoll)
      process.removeListener("SIGINT", interrupted)
      process.removeListener("SIGTERM", interrupted)
    }
    child.once("error", (cause) => {
      cleanup()
      rejectTrust(cause)
    })
    child.once("close", (code, signal) => {
      if (escalation !== undefined) {
        try {
          if (grouped) signalProcess(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch (cause) {
          if (cause.code !== "ESRCH") failure ??= cause
        }
      }
      cleanup()
      if (failure !== undefined) rejectTrust(failure)
      else if (!trusted)
        rejectTrust(
          new Error(
            `Codex native repository/hook trust review did not persist trust (exit=${code ?? "signal"}; signal=${signal ?? "none"}; repository-prompt=${repositorySelected}; hook-prompt=${hookSelected}; trust-choice=${hookChoiceSelected}; repository-persisted=${repositoryPersisted}; hook-persisted=${hookPersisted})`
          )
        )
      else {
        progress("native-trust-terminal-closed")
        resolveTrust()
      }
    })
  })

export { establishNativeTrust }
