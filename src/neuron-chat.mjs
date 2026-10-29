import { randomUUID } from 'node:crypto'

const fail = (message, status) => Object.assign(Error(message), { status })
export function neuronChatStore(pool) {
  return {
    async reserve(wallet, body) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query("select pg_advisory_xact_lock(hashtext('neuron-chat-admission-v1'))")
        const prior = await client.query('select * from neuron_chat_attempts where wallet=$1 and request_id=$2', [wallet, body.requestId])
        if (prior.rows.length) {
          const row = prior.rows[0]
          if (row.character_id !== body.characterId || row.conversation_id !== body.conversationId || row.message !== body.message) throw fail('This request ID belongs to different chat details.', 409)
          if (row.status !== 'complete') throw fail('This attempt is pending or did not complete. Try a new attempt later.', 409)
          await client.query('commit')
          return { row, replay: true }
        }
        await client.query("update neuron_chat_attempts set status='failed' where status='pending' and created_at<clock_timestamp()-interval '60 seconds'")
        const { rows: [counts] } = await client.query(`select count(*)::int as total,
          count(*) filter(where created_at >= date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as today,
          count(*) filter(where wallet=$1 and created_at >= date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as owner_today,
          count(*) filter(where status='pending')::int as active from neuron_chat_attempts`, [wallet])
        if (counts.total >= 10000 || counts.today >= 100 || counts.owner_today >= 3) throw fail('Chat limit reached. Three attempts per wallet per UTC day; the preview also has a global cap.', 429)
        if (counts.active > 0) throw fail('Chat is busy. Try again shortly.', 429)
        const { rows: [row] } = await client.query(`insert into neuron_chat_attempts(id,wallet,request_id,conversation_id,character_id,message)
          values($1,$2,$3,$4,$5,$6) returning *`, [randomUUID(), wallet, body.requestId, body.conversationId, body.characterId, body.message])
        const { rows } = await client.query(`select message,reply from neuron_chat_attempts where wallet=$1 and character_id=$2
          and conversation_id=$3 and status='complete' order by created_at desc limit 2`, [wallet, body.characterId, body.conversationId])
        await client.query('commit')
        return { row, replay: false, history: rows.reverse().flatMap(turn => [{ role: 'user', content: turn.message }, { role: 'assistant', content: turn.reply }]) }
      } catch (error) { await client.query('rollback').catch(() => {}); throw error }
      finally { client.release() }
    },
    async finish(id, status, reply = null) {
      const result = await pool.query("update neuron_chat_attempts set status=$2,reply=$3 where id=$1 and status='pending' returning id", [id, status, reply])
      if (!result.rows.length) throw fail('Chat attempt expired.', 409)
    },
  }
}
