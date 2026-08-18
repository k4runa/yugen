import { useEffect, useState } from 'react'
import { MantineProvider } from '@mantine/core';
import { Slider, Button, Group, TextInput} from '@mantine/core';

import '@mantine/core/styles.css';
import './App.css'

export default function App() 
{
    const [songs, set_songs] = useState<string[]>([]);
    const file_path: string = "/home/g4lice/Musics/";

    const [length, set_length] = useState(0);
    const [position, set_position] = useState(0);
    const [paused, set_paused] = useState<boolean>(false);
    const [looped, set_looped] = useState<boolean>(false);
    const [metadata_map, set_metadata_map] = useState<Record<string, string[]>>({});
    const [search_results, set_search_results] = useState<string[]>([]);
    const [covers_map, set_covers_map] = useState<Record<string, string>>({});
    const [query, set_query] = useState("");
    
    const icon = paused ? "▶" : "◼"; 
    const looped_icon = looped ? "👍️" : "👎️";

    useEffect(() => {
        const interval = setInterval(async () => {
            const pos = await get_position();
            const len = await get_length();
            
            set_position(pos);
            set_length(len);
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    async function fetch_songs_on_click() {
        // @ts-ignore
        const res_vec = await window.saucer.exposed.fetch_songs(file_path);
        set_songs(res_vec);

        const metadata_map: Record<string, string[]> = {};
        const covers_map: Record<string, string> = {};
        
        for(const name of res_vec) {
            // @ts-ignore
            metadata_map[name] = await window.saucer.exposed.get_metadata(file_path  + name);
            // @ts-ignore
            covers_map[name] = await window.saucer.exposed.get_cover(file_path  + name);
        }

        set_metadata_map(metadata_map);
        set_covers_map(covers_map);
    }

    async function play_music(cover_name: string) {
        // @ts-ignore
        await window.saucer.exposed.play_music(file_path + cover_name);    
    }

    async function get_position() {
        // @ts-ignore
        const res = await window.saucer.exposed.get_position();
        return res;
    }
    
    async function get_length() {
        // @ts-ignore
        const res = await window.saucer.exposed.get_length();
        return res;
    }

    async function toggle_loop() {
        // @ts-ignore
        await window.saucer.exposed.toggle_loop();
        set_looped(!looped);
    }

    async function toggle_pause() {
        if (paused) {
            // @ts-ignore
            await window.saucer.exposed.resume();
        } else {
            // @ts-ignore
            await window.saucer.exposed.stop();
        }
        set_paused(!paused);
    }

    async function search() {
        // @ts-ignore
        const res = await window.saucer.exposed.search(query, 10);
        set_search_results(res);
    }

    async function download(id: string) {
        // @ts-ignore
        await window.saucer.exposed.download(id, file_path);
        await fetch_songs_on_click();
    }

    return (
        <MantineProvider defaultColorScheme='dark'>
            <div className='app-container'>
                <div className='sidebar'>
                    <TextInput placeholder='Search on youtube...'  value={query} 
                    onChange={(e) => set_query(e.currentTarget.value)}
                    onKeyDown={(e) => {if (e.key === 'Enter') search();}} />
                    {Array.from({length: Math.floor(search_results.length / 3)}, (_, i) => (
                        <div key={i}  onClick={() => download(search_results[i * 3 + 1])} style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                            <img src={search_results[i * 3 + 2]} width={80} />
                            <span>{search_results[i * 3]}</span>
                        </div>
                    ))}
                </div>
                <div className='main-content'>
                    <Button variant='subtle' color='gray' radius="sm" onClick={fetch_songs_on_click}>Fetch songs</Button>
                        {songs.map((name: string) => (
                            <div key={name} onClick={() => play_music(name)} style={{display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer'}}>
                                {covers_map[name] && <img src={`data:image/jpeg;base64,${covers_map[name]}`} width={50} height={50} style={{borderRadius: '4px'}} />}
                                <div className='track'>
                                    <div>{metadata_map[name]?.[0] || name}</div>
                                    <p>-</p>
                                    <div style={{color: '', fontSize: '12px'}}>{metadata_map[name]?.[1] || "Unknown"}</div>
                                </div>
                            </div>
                        ))}
                </div>
                <div className='player-bar'>
                    <Slider value={position} min={0} max={length}/>

                    <Group gap="sm" p="sm" align='center' justify='center'>
                        <Button radius="sm" w={200} onClick={toggle_pause}>{icon}</Button>
                        <Button radius="sm" w={200} onClick={toggle_loop}>Loop: {looped_icon}</Button>
                    </Group>
                </div>
            </div>
        </MantineProvider>
    );
}
