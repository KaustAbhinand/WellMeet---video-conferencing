import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = "https://shymbrulgbtrbjhihrqx.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNoeW1icnVsZ2J0cmJqaGlocnF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3NjA5NDksImV4cCI6MjEwOTMzNjk0OX0.ipe9fjTxZ0LkACAz3l19zXIAI21F42LyBhcFW9f_Vdg";

export const supabase = createClient(supabaseUrl, supabaseKey);