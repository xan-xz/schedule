// Pending integration: configure with the selected project's public URL/key.
// Never pass a service-role key to browser code.
export class SharedSchedule {
  constructor(client, onChange, onStatus = () => {}) {
    this.client = client;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.id = '06-057-25-11';
    this.revision = 0;
  }
  accept(row) {
    if (!row || row.id !== this.id || row.revision <= this.revision) return;
    if (!row.data || Object.keys(row.data).length !== 7) throw new Error('Некорректное расписание');
    for (let d = 0; d < 7; d++) {
      for (const g of ['А', 'Б']) {
        if (!Array.isArray(row.data[d]?.[g])) throw new Error('Некорректная подгруппа');
        for (const l of row.data[d][g]) {
          if (typeof l.subject !== 'string' || typeof l.room !== 'string' ||
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(l.start) ||
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(l.end) || l.start >= l.end) {
            throw new Error('Некорректное занятие');
          }
        }
      }
    }
    this.revision = row.revision;
    this.onChange(structuredClone(row.data));
  }
  async refresh() {
    const {data, error} = await this.client.from('group_schedule')
      .select('id,data,revision').eq('id', this.id).single();
    if (error) throw error;
    this.accept(data);
  }
  async start() {
    this.channel = this.client.channel('schedule-' + this.id)
      .on('postgres_changes', {event: 'UPDATE', schema: 'public', table: 'group_schedule', filter: 'id=eq.' + this.id},
        payload => {
          try { this.accept(payload.new); }
          catch (error) { this.onStatus('error', error); }
        })
      .subscribe(status => {
        this.onStatus(status);
        if (status === 'SUBSCRIBED') this.refresh().catch(error => this.onStatus('error', error));
      });
    await this.refresh();
  }
  async login(email, password) {
    const {data, error} = await this.client.auth.signInWithPassword({email, password});
    if (error) throw error;
    const role = await this.client.from('schedule_admins').select('user_id')
      .eq('user_id', data.user.id).maybeSingle();
    if (role.error || !role.data) {
      await this.client.auth.signOut();
      throw new Error('Нет прав администратора');
    }
  }
  async save(schedule, expectedRevision) {
    // Use the revision captured when opening the editor, not the current
    // live revision: reject a stale draft if another admin saved meanwhile.
    const {data, error} = await this.client.from('group_schedule')
      .update({data: schedule}).eq('id', this.id).eq('revision', expectedRevision)
      .select('id,data,revision').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Расписание уже изменено. Открой редактор заново.');
    this.accept(data);
  }
  async stop() {
    if (this.channel) await this.client.removeChannel(this.channel);
  }
}