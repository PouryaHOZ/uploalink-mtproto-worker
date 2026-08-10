import sys
import os
import subprocess
import re

def apply_patch():
    print("==================================================")
    print("🛠️  Anchored Range Auto-Patcher & Git Committer")
    print("📋 Paste the patch block below.")
    print("⌨️  Press Enter, then Ctrl+D (or Ctrl+Z on Windows) when done.")
    print("==================================================\n")
    
    raw_input_data = sys.stdin.read().replace('\r\n', '\n')

    if not raw_input_data.strip():
        print("❌ Error: No input received. Exiting.")
        return

    # 1. Parse Commit Message
    commit_msg = ""
    commit_match = re.search(r'=== COMMIT ===\n(.*?)\n=== END COMMIT ===', raw_input_data, re.DOTALL)
    if commit_match:
        commit_msg = commit_match.group(1).strip()
        print("✅ Parsed commit message.")
    else:
        print("⚠️ Warning: No commit message block found.")

    # 2. Parse File Blocks
    file_blocks = raw_input_data.split("=== FILE: ")
    files_to_commit = set()

    # Regex to capture optional line hint [Lstart-Lend], Search block, and Replace block
    block_pattern = re.compile(
        r'<<<< SEARCH(?: \[L(\d+)-L(\d+)\])?\n(.*?)\n==== REPLACE\n(.*?)\n>>>> END',
        re.DOTALL
    )

    for block in file_blocks[1:]:
        lines = block.split("\n", 1)
        filepath = lines[0].replace("===", "").strip()
        changes_content = lines[1] if len(lines) > 1 else ""

        if not os.path.exists(filepath):
            print(f"❌ File not found: {filepath}. Skipping.")
            continue

        with open(filepath, 'r', encoding='utf-8') as f:
            file_text = f.read().replace('\r\n', '\n').replace('\xa0', ' ').replace('\r\n', '\n')

        file_lines = file_text.splitlines(keepends=True)
        changes_made = False

        for match in block_pattern.finditer(changes_content):
            line_start = int(match.group(1)) if match.group(1) else None
            line_end = int(match.group(2)) if match.group(2) else None
            search_str = match.group(3)
            replace_str = match.group(4)

            search_lines = search_str.splitlines(keepends=True)
            search_len = len(search_lines)

            applied = False

            # --- STAGE 1: Line Hint Window Search ---
            if line_start is not None and line_end is not None:
                # Search within +/- 30 lines of the provided line hint
                window_min = max(0, line_start - 35)
                window_max = min(len(file_lines), line_end + 35)

                for i in range(window_min, max(window_min + 1, window_max - search_len + 1)):
                    chunk = "".join(file_lines[i : i + search_len])
                    if chunk.rstrip() == search_str.rstrip():
                        file_lines[i : i + search_len] = [replace_str + ("\n" if not replace_str.endswith("\n") else "")]
                        applied = True
                        changes_made = True
                        print(f"✅ Applied patch at lines {i+1}-{i+search_len} in {filepath}")
                        break

            # --- STAGE 2: Global File Match (If Stage 1 missed or no line hint) ---
            if not applied:
                current_file_text = "".join(file_lines)
                occurrences = current_file_text.count(search_str)

                if occurrences == 1:
                    current_file_text = current_file_text.replace(search_str, replace_str, 1)
                    file_lines = current_file_text.splitlines(keepends=True)
                    applied = True
                    changes_made = True
                    print(f"✅ Applied global unique match in {filepath}")
                elif occurrences > 1:
                    print(f"❌ Ambiguous match: Found {occurrences} identical blocks in {filepath}. Provide stricter line bounds.")
                else:
                    # Stage 3: Flexible Whitespace Match
                    stripped_search = search_str.strip()
                    if stripped_search in current_file_text:
                        current_file_text = current_file_text.replace(stripped_search, replace_str.strip(), 1)
                        file_lines = current_file_text.splitlines(keepends=True)
                        applied = True
                        changes_made = True
                        print(f"✅ Applied flexible whitespace match in {filepath}")
                    else:
                        print(f"❌ Failed to locate snippet in {filepath}:\n{search_str[:120]}...\n")

        if changes_made:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.writelines(file_lines)
            files_to_commit.add(filepath)

    # 3. Git Commit and Push
    if files_to_commit and commit_msg:
        print(f"\n🚀 Committing and pushing {len(files_to_commit)} file(s)...")
        try:
            subprocess.run(['git', 'add'] + list(files_to_commit), check=True)
            
            with open('.git_commit_msg.tmp', 'w', encoding='utf-8') as f:
                f.write(commit_msg)
            
            subprocess.run(['git', 'commit', '-F', '.git_commit_msg.tmp'], check=True)
            os.remove('.git_commit_msg.tmp')
            
            print("☁️ Pushing changes to remote repository...")
            subprocess.run(['git', 'push'], check=True)
            print("\n🎉 Patch applied, committed, and pushed successfully!")
        except subprocess.CalledProcessError as e:
            print(f"\n❌ Git operation failed: {e}")
    else:
        print("\n⚠️ No modifications applied or missing commit message.")

if __name__ == "__main__":
    apply_patch()