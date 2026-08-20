import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import mascotImage from "../assets/icons/mascota-transparent.png";
import "./Mascot.css";

type Panel = "menu" | "chatbot" | "help" | "utilities" | "games";
type HelpTopic = "technical" | "project" | "sessions" | "terminal" | "open_source" | "architecture";
type Utility = "menu" | "notes" | "coin" | "timer" | "calculator" | "snake";
type Game = "menu" | "snake" | "minesweeper";

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="mascot__option" onClick={(event) => { event.stopPropagation(); onClick(); }}><span>{label}</span><span aria-hidden="true">→</span></button>;
}

function Calculator() {
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState("");
  const press = (value: string) => {
    if (value === "C") {
      setExpression("");
      setResult("");
    } else if (value === "=") {
      if (!/^[0-9+\-*/().\s]+$/.test(expression)) return;
      try {
        const answer = Number(Function(`"use strict"; return (${expression})`)());
        setResult(Number.isFinite(answer) ? String(answer) : "");
      } catch {
        setResult("");
      }
    } else {
      setExpression((current) => current + value);
    }
  };

  return <div className="mascot__calculator"><div className="mascot__calculator-display"><span>{expression || "0"}</span><strong>{result}</strong></div><div className="mascot__calculator-grid">{["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "C", "+", "(", ")", "="].map((value) => <button type="button" key={value} className={`mascot__calculator-key${value === "=" ? " is-equals" : ""}`} onClick={(event) => { event.stopPropagation(); press(value); }}>{value === "*" ? "×" : value === "/" ? "÷" : value}</button>)}</div></div>;
}

type Point = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";
const SNAKE_WIDTH = 12;
const SNAKE_HEIGHT = 12;
const INITIAL_SNAKE: Point[] = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];

function randomFood(snake: Point[]): Point {
  let food: Point;
  do {
    food = { x: Math.floor(Math.random() * SNAKE_WIDTH), y: Math.floor(Math.random() * SNAKE_HEIGHT) };
  } while (snake.some((part) => part.x === food.x && part.y === food.y));
  return food;
}

function SnakeGame({ t }: { t: TFunction }) {
  const [snake, setSnake] = useState<Point[]>(INITIAL_SNAKE);
  const snakeRef = useRef<Point[]>(INITIAL_SNAKE);
  const [food, setFood] = useState<Point>(() => randomFood(INITIAL_SNAKE));
  const foodRef = useRef<Point>(food);
  const directionRef = useRef<Direction>("right");
  const pendingDirectionRef = useRef<Direction | null>(null);
  const gameStateRef = useRef<"ready" | "countdown" | "playing" | "over">("ready");
  const [gameState, setGameState] = useState<"ready" | "countdown" | "playing" | "over">("ready");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [score, setScore] = useState(0);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keys: Partial<Record<string, Direction>> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      const next = keys[event.key];
      if (!next) return;
      event.preventDefault();
      changeDirection(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (gameState !== "countdown" || countdown === null) return;
    const timer = window.setTimeout(() => {
      if (countdown <= 1) {
        setCountdown(null);
        setGameState("playing");
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, gameState]);

  useEffect(() => {
    if (gameState !== "playing") return;
    const timer = window.setInterval(() => {
      const nextDirection = pendingDirectionRef.current ?? directionRef.current;
      pendingDirectionRef.current = null;
      directionRef.current = nextDirection;
      const current = snakeRef.current;
      const head = current[0];
      const next = { x: head.x + (nextDirection === "right" ? 1 : nextDirection === "left" ? -1 : 0), y: head.y + (nextDirection === "down" ? 1 : nextDirection === "up" ? -1 : 0) };
      const hitsWall = next.x < 0 || next.x >= SNAKE_WIDTH || next.y < 0 || next.y >= SNAKE_HEIGHT;
      const hitsSelf = current.some((part) => part.x === next.x && part.y === next.y);
      if (hitsWall || hitsSelf) {
        setGameState("over");
        return;
      }
      const ate = next.x === foodRef.current.x && next.y === foodRef.current.y;
      const updated = [next, ...current].slice(0, ate ? current.length + 1 : current.length);
      snakeRef.current = updated;
      setSnake(updated);
      if (ate) {
        setScore((value) => value + 1);
        const nextFood = randomFood(updated);
        foodRef.current = nextFood;
        setFood(nextFood);
      }
    }, 180);
    return () => window.clearInterval(timer);
  }, [food, gameState]);

  const start = () => {
    setSnake(INITIAL_SNAKE);
    snakeRef.current = INITIAL_SNAKE;
    const nextFood = randomFood(INITIAL_SNAKE);
    setFood(nextFood);
    foodRef.current = nextFood;
    directionRef.current = "right";
    pendingDirectionRef.current = null;
    setScore(0);
    setCountdown(3);
    setGameState("countdown");
  };
  const changeDirection = (next: Direction) => {
    const current = directionRef.current;
    if (gameStateRef.current !== "playing" || pendingDirectionRef.current !== null) return;
    if ((current === "up" && next === "down") || (current === "down" && next === "up") || (current === "left" && next === "right") || (current === "right" && next === "left")) return;
    pendingDirectionRef.current = next;
  };

  const status = gameState === "countdown" ? "" : gameState === "over" ? `${t("mascot.utilities.game_over")} · ${t("mascot.utilities.score")}: ${score}` : `${t("mascot.utilities.score")}: ${score}`;
  const actionLabel = t("mascot.utilities.retry");

  return <div className="mascot__snake"><div className="mascot__game-status">{status}</div><div className="mascot__snake-board" style={{ gridTemplateColumns: `repeat(${SNAKE_WIDTH}, 1fr)` }} role="grid" aria-label={t("mascot.utilities.snake")}>
    {Array.from({ length: SNAKE_WIDTH * SNAKE_HEIGHT }, (_, index) => { const point = { x: index % SNAKE_WIDTH, y: Math.floor(index / SNAKE_WIDTH) }; const isSnake = snake.some((part) => part.x === point.x && part.y === point.y); const isFood = gameState === "playing" && food.x === point.x && food.y === point.y; return <span key={index} className={`mascot__snake-cell${isSnake ? " is-snake" : ""}${isFood ? " is-food" : ""}`} />; })}
  </div><div className="mascot__snake-action-slot">{gameState === "countdown" ? <strong className="mascot__snake-countdown">{countdown}</strong> : gameState === "ready" ? <button type="button" className="mascot__snake-action" onClick={(event) => { event.stopPropagation(); start(); }} aria-label={t("mascot.utilities.play")}>▶</button> : gameState === "over" ? <button type="button" className="mascot__snake-action" onClick={(event) => { event.stopPropagation(); start(); }} aria-label={actionLabel}>↻</button> : <span className="mascot__snake-spacer" aria-hidden="true" />}</div></div>;
}

function Minesweeper({ t }: { t: TFunction }) {
  type Difficulty = "easy" | "medium" | "hard";
  const levels: Record<Difficulty, { size: number; mines: number }> = { easy: { size: 8, mines: 10 }, medium: { size: 12, mines: 25 }, hard: { size: 16, mines: 50 } };
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const { size, mines: mineCount } = levels[difficulty];
  const [mines, setMines] = useState<Set<number>>(new Set());
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [flagged, setFlagged] = useState<Set<number>>(new Set());
  const [outcome, setOutcome] = useState<"playing" | "lost" | "won">("playing");
  const [started, setStarted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  const createMines = (firstIndex: number) => {
    const next = new Set<number>();
    while (next.size < mineCount) {
      const candidate = Math.floor(Math.random() * size * size);
      if (candidate !== firstIndex) next.add(candidate);
    }
    return next;
  };
  const neighbors = (index: number) => {
    const x = index % size;
    const y = Math.floor(index / size);
    return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => ({ x: x + dx, y: y + dy })))
      .filter(({ x: nextX, y: nextY }) => (nextX !== x || nextY !== y) && nextX >= 0 && nextX < size && nextY >= 0 && nextY < size)
      .map(({ x: nextX, y: nextY }) => nextY * size + nextX);
  };
  const adjacentMines = (index: number, mineSet: Set<number>) => neighbors(index).filter((neighbor) => mineSet.has(neighbor)).length;
  const revealCell = (index: number) => {
    if (outcome !== "playing" || revealed.has(index) || flagged.has(index)) return;
    const activeMines = mines.size === 0 ? createMines(index) : mines;
    if (mines.size === 0) {
      setMines(activeMines);
      setStarted(true);
      startedAt.current = Date.now();
    }
    if (activeMines.has(index)) {
      setOutcome("lost");
      setRevealed(new Set(Array.from({ length: size * size }, (_, value) => value)));
      return;
    }
    const nextRevealed = new Set(revealed);
    const pending = [index];
    while (pending.length) {
      const current = pending.pop()!;
      if (nextRevealed.has(current) || activeMines.has(current) || flagged.has(current)) continue;
      nextRevealed.add(current);
      if (adjacentMines(current, activeMines) === 0) pending.push(...neighbors(current));
    }
    setRevealed(nextRevealed);
    if (nextRevealed.size >= size * size - mineCount) setOutcome("won");
  };
  const toggleFlag = (index: number) => {
    if (outcome !== "playing" || revealed.has(index)) return;
    setFlagged((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };
  useEffect(() => {
    if (!started || outcome !== "playing") return;
    const timer = window.setInterval(() => {
      if (startedAt.current) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [outcome, started]);
  const reset = () => { setMines(new Set()); setRevealed(new Set()); setFlagged(new Set()); setOutcome("playing"); setStarted(false); setElapsed(0); startedAt.current = null; };
  const chooseDifficulty = (next: Difficulty) => { setDifficulty(next); reset(); };
  const timeLabel = `${Math.floor(elapsed / 60).toString().padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
  const status = outcome === "lost" ? `${t("mascot.games.minesweeper_lost")} · ${t("mascot.utilities.timer")}: ${timeLabel}` : outcome === "won" ? `${t("mascot.games.minesweeper_won")} · ${t("mascot.utilities.timer")}: ${timeLabel}` : `${t("mascot.games.minesweeper_hint")} · ${t("mascot.utilities.timer")}: ${timeLabel}`;
  return <div className="mascot__minesweeper"><div className="mascot__difficulty" role="group" aria-label={t("mascot.games.difficulty")}><button type="button" className={difficulty === "easy" ? "is-active" : ""} onClick={() => chooseDifficulty("easy")}>{t("mascot.games.easy")}</button><button type="button" className={difficulty === "medium" ? "is-active" : ""} onClick={() => chooseDifficulty("medium")}>{t("mascot.games.medium")}</button><button type="button" className={difficulty === "hard" ? "is-active" : ""} onClick={() => chooseDifficulty("hard")}>{t("mascot.games.hard")}</button></div><div className="mascot__game-status">{status}</div><div className={`mascot__mine-board mascot__mine-board--${difficulty}`} style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }} role="grid" aria-label={t("mascot.games.minesweeper")}>{Array.from({ length: size * size }, (_, index) => { const isRevealed = revealed.has(index); const isMine = mines.has(index); const isFlagged = flagged.has(index) || outcome === "won" && isMine; const count = adjacentMines(index, mines); return <button type="button" key={index} className={`mascot__mine-cell${isRevealed ? " is-revealed" : ""}${isMine && outcome === "lost" ? " is-mine" : ""}${isFlagged && outcome === "won" ? " is-correct" : ""}`} onClick={(event) => { event.stopPropagation(); revealCell(index); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); toggleFlag(index); }} role="gridcell">{isFlagged ? "⚑" : isMine && outcome === "lost" ? "×" : isRevealed && count > 0 ? count : ""}</button>; })}</div><button type="button" className="mascot__back" onClick={(event) => { event.stopPropagation(); reset(); }}>{t("mascot.utilities.reset")}</button><div className="mascot__mine-help"><div className="mascot__mine-help-item"><span className="mascot__mouse mascot__mouse--left" aria-hidden="true"><i /></span><span>{t("mascot.games.left_click")}</span></div><div className="mascot__mine-help-item"><span className="mascot__mouse mascot__mouse--right" aria-hidden="true"><i /></span><span>{t("mascot.games.right_click")}</span></div></div></div>;
}

function Utilities({
  t,
  utility,
  setUtility,
  notes,
  setNotes,
  coinSide,
  coinFlipping,
  flipCoin,
  seconds,
  timerRunning,
  setTimerRunning,
  setSeconds,
}: {
  t: TFunction;
  utility: Utility;
  setUtility: (utility: Utility) => void;
  notes: string;
  setNotes: (notes: string) => void;
  coinSide: "heads" | "tails" | null;
  coinFlipping: boolean;
  flipCoin: () => void;
  seconds: number;
  timerRunning: boolean;
  setTimerRunning: (running: boolean) => void;
  setSeconds: (seconds: number) => void;
}) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");

  if (utility === "notes") {
    return <div className="mascot__utility"><textarea className="mascot__notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("mascot.utilities.notes_placeholder")} aria-label={t("mascot.utilities.notes")} /><span className="mascot__utility-hint">{t("mascot.utilities.notes_hint")}</span></div>;
  }
  if (utility === "coin") {
    return <div className="mascot__utility mascot__utility--center"><div className={`mascot__coin${coinFlipping ? " is-flipping" : ""}${coinSide === "tails" ? " is-tails" : ""}`} aria-label={coinSide === "heads" ? t("mascot.utilities.heads") : coinSide === "tails" ? t("mascot.utilities.tails") : t("mascot.utilities.coin")}><span className="mascot__coin-face mascot__coin-face--heads"><span className="mascot__coin-eye mascot__coin-eye--left" /><span className="mascot__coin-eye mascot__coin-eye--right" /><span className="mascot__coin-smile" /></span><span className="mascot__coin-face mascot__coin-face--tails"><span className="mascot__coin-cross mascot__coin-cross--one" /><span className="mascot__coin-cross mascot__coin-cross--two" /></span></div><button type="button" className="mascot__utility-action" onClick={(event) => { event.stopPropagation(); flipCoin(); }}>{t("mascot.utilities.flip")}</button></div>;
  }
  if (utility === "timer") {
    return <div className="mascot__utility mascot__utility--center"><label className="mascot__timer-label" htmlFor="mascot-timer-seconds">{t("mascot.utilities.duration")}</label><input id="mascot-timer-seconds" className="mascot__timer-input" type="number" min="1" max="3600" value={seconds} onChange={(event) => { setSeconds(Math.max(1, Math.min(3600, Number(event.target.value) || 1))); setTimerRunning(false); }} /><div className="mascot__timer">{minutes}:{remainder}</div><div className="mascot__timer-actions"><button type="button" className="mascot__utility-action" onClick={(event) => { event.stopPropagation(); setTimerRunning(!timerRunning); }}>{timerRunning ? t("mascot.utilities.pause") : t("mascot.utilities.start")}</button><button type="button" className="mascot__back" onClick={(event) => { event.stopPropagation(); setSeconds(300); setTimerRunning(false); }}>{t("mascot.utilities.reset")}</button></div></div>;
  }
  if (utility === "calculator") {
    return <Calculator />;
  }
  if (utility === "snake") {
    return <SnakeGame t={t} />;
  }
  return <div className="mascot__options"><ActionButton label={t("mascot.utilities.notes")} onClick={() => setUtility("notes")} /><ActionButton label={t("mascot.utilities.coin")} onClick={() => setUtility("coin")} /><ActionButton label={t("mascot.utilities.timer")} onClick={() => setUtility("timer")} /><ActionButton label={t("mascot.utilities.calculator")} onClick={() => setUtility("calculator")} /></div>;
}

export function Mascot() {
  const { t } = useTranslation();
  const [speaking, setSpeaking] = useState(false);
  const [panel, setPanel] = useState<Panel>("menu");
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [utility, setUtility] = useState<Utility>("menu");
  const [game, setGame] = useState<Game>("menu");
  const [notes, setNotes] = useState("");
  const [coinSide, setCoinSide] = useState<"heads" | "tails" | null>(null);
  const [coinFlipping, setCoinFlipping] = useState(false);
  const [seconds, setSeconds] = useState(300);
  const [timerRunning, setTimerRunning] = useState(false);
  const mascotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!speaking) return;
    const closeOnOutsideClick = (event: MouseEvent) => { if (!mascotRef.current?.contains(event.target as Node)) setSpeaking(false); };
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [speaking]);

  useEffect(() => {
    if (!timerRunning || seconds <= 0) return;
    const timer = window.setInterval(() => {
      setSeconds((value) => {
        if (value <= 1) {
          setTimerRunning(false);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [timerRunning, seconds]);

  const flipCoin = () => {
    if (coinFlipping) return;
    setCoinSide(Math.random() < 0.5 ? "heads" : "tails");
    setCoinFlipping(true);
    window.setTimeout(() => {
      setCoinFlipping(false);
    }, 650);
  };

  const open = () => { setPanel("menu"); setHelpTopic(null); setUtility("menu"); setGame("menu"); setSpeaking(true); };
  const back = () => {
    if (panel === "help") {
      if (helpTopic === "sessions" || helpTopic === "terminal") {
        setHelpTopic("technical");
        return;
      }
      if (helpTopic === "open_source" || helpTopic === "architecture") {
        setHelpTopic("project");
        return;
      }
      if (helpTopic === "technical" || helpTopic === "project") {
        setHelpTopic(null);
        return;
      }
      setPanel("menu");
      return;
    }
    if (panel === "chatbot" || panel === "utilities" && utility === "menu" || panel === "games" && game === "menu") {
      setPanel("menu");
      setHelpTopic(null);
      setUtility("menu");
      setGame("menu");
      return;
    }
    if (panel === "utilities") setUtility("menu");
    if (panel === "games") setGame("menu");
  };
  const panelTitle = panel === "menu" ? "mascot.greeting" : panel === "chatbot" ? "mascot.chatbot.title" : panel === "help" ? "mascot.help.title" : panel === "utilities" ? "mascot.utilities.title" : "mascot.games.title";
  const explanation = helpTopic === "sessions" ? t("mascot.explanations.sessions")
    : helpTopic === "terminal" ? t("mascot.explanations.terminal")
      : helpTopic === "open_source" ? t("mascot.explanations.open_source")
        : helpTopic === "architecture" ? t("mascot.explanations.architecture") : "";

  return <div ref={mascotRef} className={`mascot${speaking ? " is-open" : ""}`} aria-live="polite">
    {speaking && <div className="mascot__bubble mascot__window">
      <div className="mascot__message-row"><strong>{t(panelTitle)}</strong><button type="button" className="mascot__close" onClick={(event) => { event.stopPropagation(); setSpeaking(false); }} aria-label={t("mascot.close")}>×</button></div>
      {panel === "menu" && <div className="mascot__options"><ActionButton label={t("mascot.options.chatbot")} onClick={() => setPanel("chatbot")} /><ActionButton label={t("mascot.options.help")} onClick={() => setPanel("help")} /><ActionButton label={t("mascot.options.utilities")} onClick={() => { setPanel("utilities"); setUtility("menu"); }} /><ActionButton label={t("mascot.options.games")} onClick={() => { setPanel("games"); setGame("menu"); }} /></div>}
      {panel === "chatbot" && <div className="mascot__placeholder"><p>{t("mascot.chatbot.body")}</p><span className="mascot__tag">{t("mascot.chatbot.badge")}</span></div>}
      {panel === "help" && !helpTopic && <div className="mascot__options"><ActionButton label={t("mascot.help.technical")} onClick={() => setHelpTopic("technical")} /><ActionButton label={t("mascot.help.project")} onClick={() => setHelpTopic("project")} /></div>}
      {panel === "help" && helpTopic === "technical" && <div className="mascot__options"><ActionButton label={t("mascot.help.sessions")} onClick={() => setHelpTopic("sessions")} /><ActionButton label={t("mascot.help.terminal")} onClick={() => setHelpTopic("terminal")} /></div>}
      {panel === "help" && helpTopic === "project" && <div className="mascot__options"><ActionButton label={t("mascot.help.open_source")} onClick={() => setHelpTopic("open_source")} /><ActionButton label={t("mascot.help.architecture")} onClick={() => setHelpTopic("architecture")} /></div>}
      {panel === "help" && helpTopic && explanation && <div className="mascot__explanation"><p>{explanation}</p></div>}
      {panel === "utilities" && <Utilities t={t} utility={utility} setUtility={setUtility} notes={notes} setNotes={setNotes} coinSide={coinSide} coinFlipping={coinFlipping} flipCoin={flipCoin} seconds={seconds} timerRunning={timerRunning} setTimerRunning={setTimerRunning} setSeconds={setSeconds} />}
      {panel === "games" && game === "menu" && <div className="mascot__options"><ActionButton label={t("mascot.utilities.snake")} onClick={() => setGame("snake")} /><ActionButton label={t("mascot.games.minesweeper")} onClick={() => setGame("minesweeper")} /></div>}
      {panel === "games" && game === "snake" && <SnakeGame t={t} />}
      {panel === "games" && game === "minesweeper" && <Minesweeper t={t} />}
      {panel !== "menu" && <button type="button" className="mascot__back mascot__back--nav" onClick={(event) => { event.stopPropagation(); back(); }} aria-label={t("mascot.back")}><span aria-hidden="true">←</span></button>}
    </div>}
    <button type="button" className="mascot__button" onClick={(event) => { event.stopPropagation(); open(); }} aria-label={t("mascot.open")} aria-expanded={speaking}><img className="mascot__image" src={mascotImage} alt="" /></button>
  </div>;
}
