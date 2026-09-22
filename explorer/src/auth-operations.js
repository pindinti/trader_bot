function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} é obrigatório.`);
  return value.trim();
}

export async function performPasswordSignIn(auth, email, password) {
  const normalizedEmail = requiredText(email, 'E-mail');
  if (typeof password !== 'string' || !password) throw new TypeError('Senha é obrigatória.');
  const { data, error } = await auth.signInWithPassword({ email: normalizedEmail, password });
  if (error) throw error;
  if (!data?.session?.user?.id) throw new Error('O Supabase não retornou uma sessão válida.');
  return data.session;
}

export async function performPasswordRecovery(auth, email, redirectTo) {
  const normalizedEmail = requiredText(email, 'E-mail');
  const { error } = await auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
  if (error) throw error;
}

export async function performPasswordUpdate(auth, password) {
  if (typeof password !== 'string' || !password) throw new TypeError('Nova senha é obrigatória.');
  const { data, error } = await auth.updateUser({ password });
  if (error) throw error;
  if (!data?.user?.id) throw new Error('O Supabase não confirmou a atualização da senha.');
  return data.user;
}
