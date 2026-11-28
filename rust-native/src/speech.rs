//! Stateful recognition deduplication and utterance lifecycle.
use crate::recognition::{Command, Gate, Parser};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct SpeechSession {
    gate: Gate,
    done: String,
    part: String,
    sent_count: BTreeMap<String, usize>,
    sent_at: BTreeMap<String, u64>,
    last_text_at: u64,
}
impl SpeechSession {
    fn full(&self) -> String {
        format!("{} {}", self.done, self.part).trim().to_owned()
    }
    fn key(c: &Command) -> String {
        if c.prepare_only { format!("подготовить {}", c.phrase) } else { c.phrase.clone() }
    }
    fn submit(&mut self, now: u64, list: Vec<Command>) -> Vec<Command> {
        let mut batch = Vec::new();
        let mut seen = BTreeMap::new();
        for c in list {
            let key = Self::key(&c);
            let count = seen.entry(key.clone()).or_insert(0);
            *count += 1;
            let sent = self.sent_count.entry(key.clone()).or_insert(0);
            if *count <= *sent { continue; }
            *sent = *count;
            if self.sent_at.get(&key).is_some_and(|at| now.saturating_sub(*at) < 2500) { continue; }
            self.sent_at.insert(key, now);
            batch.push(c);
        }
        batch
    }
    pub fn reset(&mut self, now: u64) {
        self.done.clear(); self.part.clear(); self.sent_count.clear(); self.gate.reset();
        self.last_text_at = now;
        self.sent_at.retain(|_, at| now.saturating_sub(*at) < 2500);
    }
    pub fn observe(&mut self, p: &Parser, now: u64, text: &str, finalized: bool) -> Vec<Command> {
        if finalized {
            if !text.is_empty() {
                self.done = format!("{} {}", self.done, text).trim().to_owned();
                self.last_text_at = now;
            }
            self.part.clear();
        } else {
            if self.part != text { self.last_text_at = now; }
            self.part = text.to_owned();
        }
        let full = self.full();
        let list = self.gate.read(p, &full, finalized);
        let mut result = self.submit(now, list);
        if !self.done.is_empty() && self.part.is_empty() && now.saturating_sub(self.last_text_at) >= 1200 {
            result.extend(self.end(p, now));
        }
        result
    }
    pub fn end(&mut self, p: &Parser, now: u64) -> Vec<Command> {
        let full = self.full();
        self.gate.read(p, &full, false);
        let finalized = self.gate.read(p, &self.done, true);
        let mut result = self.submit(now, finalized);
        let partial = self.gate.read(p, &full, false);
        result.extend(self.submit(now, partial));
        self.reset(now);
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog, config::Config};
    fn parser() -> Parser { Parser::new(&catalog::resolve(&Config::default(), None)) }
    #[test]
    fn partial_final_and_repeat_do_not_double_cast() {
        let p = parser(); let mut s = SpeechSession::default();
        assert_eq!(s.observe(&p, 100, "торнадо", false).len(), 1);
        assert!(s.observe(&p, 101, "торнадо", true).is_empty());
        assert_eq!(s.observe(&p, 102, "метеор", false).len(), 1);
        assert!(s.end(&p, 103).is_empty());
        assert!(s.observe(&p, 200, "торнадо", true).is_empty());
        s.reset(3000); assert_eq!(s.observe(&p, 3000, "торнадо", true).len(), 1);
    }
    #[test]
    fn unfinished_preparation_is_never_committed_on_release() {
        let p = parser(); let mut s = SpeechSession::default();
        assert!(s.observe(&p, 100, "готовь торнадо", false).is_empty());
        assert!(s.end(&p, 101).is_empty());
        assert!(s.observe(&p, 3000, "готовь", false).is_empty());
        let result = s.observe(&p, 3001, "готовь торнадо", true);
        assert_eq!(result.len(), 1); assert!(result[0].prepare_only);
        assert!(s.end(&p, 3002).is_empty());
    }
    #[test]
    fn idle_ends_utterance_and_new_command_is_allowed_after_cooldown() {
        let p = parser(); let mut s = SpeechSession::default();
        assert_eq!(s.observe(&p, 100, "торнадо", true).len(), 1);
        assert!(s.observe(&p, 1301, "", false).is_empty());
        assert_eq!(s.observe(&p, 2700, "торнадо", true).len(), 1);
    }
}
