//! In-process asynchronous event bus.
//!
//! Hampy is event-driven: capability crates publish state changes (a session
//! connected, PTY produced output, a transfer progressed) and the Tauri layer
//! forwards relevant events to the frontend. The bus is a thin, cloneable
//! wrapper over a [`tokio::sync::broadcast`] channel so any number of
//! subscribers can observe the stream without coupling to publishers.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::model::{SessionId, SessionStatus};

/// Default backlog retained for slow subscribers before they lag.
const DEFAULT_CAPACITY: usize = 1024;

/// A typed event flowing through the bus. New variants are additive; the enum
/// is `#[non_exhaustive]` so consumers must keep a wildcard arm.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
#[non_exhaustive]
pub enum EventKind {
    /// A session transitioned to a new lifecycle state.
    SessionStatusChanged {
        session: SessionId,
        status: SessionStatus,
    },
    /// A byte chunk of terminal/PTY output (base64 at the IPC boundary).
    TerminalOutput { session: SessionId, data: Vec<u8> },
    /// A file-transfer task progressed (0.0–1.0).
    TransferProgress {
        session: SessionId,
        task: String,
        fraction: f32,
    },
    /// A non-fatal, user-facing notification.
    Notice { level: NoticeLevel, message: String },
    /// A plugin emitted a custom event; `payload` is opaque to the core.
    Plugin {
        plugin_id: String,
        payload: serde_json::Value,
    },
}

/// Severity for [`EventKind::Notice`], mapped to design-system accent colors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// An event plus envelope metadata (id + timestamp) added by the bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: uuid::Uuid,
    pub at: chrono::DateTime<chrono::Utc>,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    fn wrap(kind: EventKind) -> Self {
        Event {
            id: uuid::Uuid::new_v4(),
            at: chrono::Utc::now(),
            kind,
        }
    }
}

/// Cloneable handle to the shared event channel. Clones share one channel.
#[derive(Clone)]
pub struct EventBus {
    sender: Arc<broadcast::Sender<Event>>,
}

impl std::fmt::Debug for EventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventBus")
            .field("subscribers", &self.sender.receiver_count())
            .finish()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl EventBus {
    /// Create a bus retaining `capacity` events for lagging subscribers.
    pub fn with_capacity(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        EventBus {
            sender: Arc::new(sender),
        }
    }

    /// Publish an event. Returns the number of subscribers that received it;
    /// publishing to zero subscribers is not an error.
    pub fn publish(&self, kind: EventKind) -> usize {
        self.sender.send(Event::wrap(kind)).unwrap_or(0)
    }

    /// Subscribe to all future events.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }

    /// Current number of live subscribers — useful for diagnostics.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn published_events_reach_subscribers() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe();

        let session = SessionId::new();
        bus.publish(EventKind::SessionStatusChanged {
            session,
            status: SessionStatus::Connected,
        });

        let evt = rx.recv().await.expect("event delivered");
        match evt.kind {
            EventKind::SessionStatusChanged { session: s, status } => {
                assert_eq!(s, session);
                assert_eq!(status, SessionStatus::Connected);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn publish_without_subscribers_is_ok() {
        let bus = EventBus::default();
        assert_eq!(
            bus.publish(EventKind::Notice {
                level: NoticeLevel::Info,
                message: "no one is listening".into(),
            }),
            0
        );
    }
}
